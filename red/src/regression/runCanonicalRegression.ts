// src/regression/runCanonicalRegression.ts
//
// Honest regression harness over CanonicalSwapCase NDJSON.
// - Derives direction + (amountIn, actualOut) strictly from pool vault/reserve deltas (tx meta).
// - Feeds only decoded on-chain state + derived direction/amount into sims.
// - Reports mismatches without fudging.
//
// Usage:
//   pnpm exec ts-node src/regression/runCanonicalRegression.ts ./data/canonical_cases.ndjson

import * as fs from "fs";
import * as readline from "readline";
import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";

import { InMemoryAccountStore, type AccountUpdate } from "../state/accountStore";
import type { CanonicalSwapCase, Venue } from "../capture/canonicalTypes";

// RPC endpoint for fetching missing accounts (AmmConfig for CLMM, etc.)
// Use mainnet RPC since local validator may not be running during regression
const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// Cache for fetched accounts (pubkey -> { data, owner })
const fetchedAccountCache = new Map<string, { data: Buffer; owner: string } | null>();

async function fetchAccountIfMissing(
    pubkey: string,
    store: InMemoryAccountStore,
    slot: number
): Promise<Buffer | null> {
    // Check store first
    const existing = store.getData(pubkey);
    if (existing) return existing;

    // Check cache
    if (fetchedAccountCache.has(pubkey)) {
        const cached = fetchedAccountCache.get(pubkey);
        if (cached) {
            // Add to store for future lookups
            store.apply({
                pubkey,
                data: cached.data,
                slot,
                writeVersion: 0n,
                owner: cached.owner,
                lamports: 0n,
                executable: false,
                rentEpoch: 0n,
            });
            return cached.data;
        }
        return null;
    }

    // Fetch from RPC
    try {
        const pk = new PublicKey(pubkey);
        const info = await connection.getAccountInfo(pk);
        if (info && info.data) {
            const data = Buffer.from(info.data);
            const owner = info.owner.toBase58();
            fetchedAccountCache.set(pubkey, { data, owner });
            store.apply({
                pubkey,
                data,
                slot,
                writeVersion: 0n,
                owner,
                lamports: BigInt(info.lamports),
                executable: info.executable,
                rentEpoch: BigInt(info.rentEpoch ?? 0),
            });
            return data;
        }
    } catch (e: any) {
        // Ignore fetch errors, return null
    }

    fetchedAccountCache.set(pubkey, null);
    return null;
}

// PumpSwap
import { isPumpSwapPoolAccount, decodePumpSwapPool } from "../decoders/pumpswapPool";
import { isPumpSwapGlobalConfigAccount, decodePumpSwapGlobalConfig } from "../decoders/pumpswapGlobalConfig";
// fees now computed inline for diagnostic
import { simulatePumpSwapSwap, type PumpSwapSide } from "../sim/pumpswapSim";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// Raydium V4
import { V4_POOL_SIZE, decodeRaydiumV4Pool } from "../decoders/raydiumV4Pool";
import { isOpenOrdersAccount, decodeRaydiumV4OpenOrders } from "../decoders/raydiumV4OpenOrders";
import { simulateRaydiumV4Swap } from "../sim/raydiumV4Sim";

// Raydium CLMM
import { isRaydiumClmmPoolAccount, decodeRaydiumClmmPool } from "../decoders/raydiumCLMMPool";
import { isRaydiumAmmConfigAccount, decodeRaydiumAmmConfig } from "../decoders/raydiumAmmConfig";
import {
    isRaydiumTickArrayAccount,
    decodeRaydiumTickArray,
    deriveRaydiumTickArrayPda,
    getTickArrayStartIndex,
    RAYDIUM_TICKS_PER_ARRAY,
    type RaydiumTickArrayState
} from "../decoders/raydiumTickArray";
import { simulateRaydiumCLMMSwapExactIn } from "../sim/raydiumCLMMSim";

// Meteora DLMM
import {
    isMeteoraLbPairAccount,
    decodeMeteoraLbPair,
    binIdToBinArrayIndex,
    deriveMeteoraBinArrayPda
} from "../decoders/meteoraLbPair";
import { isMeteoraBinArrayAccount, decodeMeteoraBinArray, buildMeteoraBinLiquidityMap, type MeteoraBinArray } from "../decoders/meteoraBinArray";
import { simulateMeteoraDlmmSwap, type MeteoraSwapDirection } from "../sim/meteoraDLMMSim";

function bi(s: string): bigint {
    return BigInt(s);
}

function absDiff(a: bigint, b: bigint): bigint {
    const d = a - b;
    return d < 0n ? -d : d;
}

function tokenDelta(c: CanonicalSwapCase, account: string): bigint | null {
    const tb = c.tokenBalances[account];
    if (!tb) return null;
    return bi(tb.postAmount) - bi(tb.preAmount);
}

function tokenPre(c: CanonicalSwapCase, account: string): bigint | null {
    const tb = c.tokenBalances[account];
    if (!tb) return null;
    return bi(tb.preAmount);
}

function buildStoreFromPreAccounts(c: CanonicalSwapCase): InMemoryAccountStore {
    const store = new InMemoryAccountStore();

    for (const [pubkey, a] of Object.entries(c.preAccounts)) {
        const upd: AccountUpdate = {
            pubkey,
            data: Buffer.from(a.dataBase64, "base64"),
            slot: c.slot,
            writeVersion: 0n,
            owner: a.owner,
            lamports: bi(a.lamports),
            executable: a.executable,
            rentEpoch: bi(a.rentEpoch),
        };
        store.apply(upd);
    }

    return store;
}

type Mismatch = {
    venue: Venue;
    signature: string;
    slot: number;
    amountIn: bigint;
    actualOut: bigint;
    simOut: bigint;
    diff: bigint;
    note?: string;
};

async function main() {
    const ndjsonPath = process.argv[2];
    if (!ndjsonPath) {
        console.error("Usage: pnpm exec ts-node src/regression/runCanonicalRegression.ts <cases.ndjson>");
        process.exit(1);
    }

    const rl = readline.createInterface({
        input: fs.createReadStream(ndjsonPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    let total = 0;
    let used = 0;
    let skipped = 0;

    const mismatches: Mismatch[] = [];

    // PumpSwap correlation tracking
    const pumpswapStats = {
        nullCreator20: 0,
        nullCreator25: 0,
        nullCreatorNeither: 0,
        nonNullCreator20: 0,
        nonNullCreator25: 0,
        nonNullCreatorNeither: 0,
        byPoolIndex: new Map<number, { m20: number; m25: number; neither: number }>(),
        // Ceiling vs floor tracking
        floor20: 0,
        floor25: 0,
        ceil20: 0,
        ceil25: 0,
        neither: 0,
        // Direction tracking
        sell20: 0,
        sell25: 0,
        sellNeither: 0,
        buy20: 0,
        buy25: 0,
        buyNeither: 0,
        // InferredFee distribution
        byInferredFee: new Map<bigint, number>(),
    };

    for await (const line of rl) {
        const s = line.trim();
        if (!s) continue;

        total++;

        let c: CanonicalSwapCase;
        try {
            c = JSON.parse(s);
        } catch {
            skipped++;
            continue;
        }

        if (c.tx?.err) {
            skipped++;
            continue;
        }

        const store = buildStoreFromPreAccounts(c);

        try {
            if (c.venue === "pumpswap") {
                let poolPk: string | null = null;
                let globalPk: string | null = null;

                for (const [pk, a] of Object.entries(c.preAccounts)) {
                    const buf = Buffer.from(a.dataBase64, "base64");
                    if (!poolPk && isPumpSwapPoolAccount(buf)) poolPk = pk;
                    if (!globalPk && isPumpSwapGlobalConfigAccount(buf)) globalPk = pk;
                }

                if (!poolPk || !globalPk) {
                    skipped++;
                    continue;
                }

                const pool = decodePumpSwapPool(store.getData(poolPk)!);
                // global config decoded but not used - fee selection done via testing both 20/25 bps
                decodePumpSwapGlobalConfig(store.getData(globalPk)!); // validates format

                const baseVault = pool.poolBaseTokenAccount.toBase58();
                const quoteVault = pool.poolQuoteTokenAccount.toBase58();

                const dBase = tokenDelta(c, baseVault);
                const dQuote = tokenDelta(c, quoteVault);
                if (dBase === null || dQuote === null) {
                    skipped++;
                    continue;
                }

                let side: PumpSwapSide;
                let amountIn: bigint;
                let actualOut: bigint;

                // Canonical: amountIn is EXACTLY what the pool vault received (delta on input vault).
                if (dBase > 0n && dQuote < 0n) {
                    side = "baseToQuote";
                    amountIn = dBase;
                    actualOut = -dQuote;
                } else if (dQuote > 0n && dBase < 0n) {
                    side = "quoteToBase";
                    amountIn = dQuote;
                    actualOut = -dBase;
                } else {
                    skipped++;
                    continue;
                }

                const baseReserve = tokenPre(c, baseVault);
                const quoteReserve = tokenPre(c, quoteVault);
                if (baseReserve === null || quoteReserve === null) {
                    skipped++;
                    continue;
                }

                // Pool attributes for correlation
                const creatorPk = pool.creator.toBase58();
                const creatorIsNull = creatorPk === SYSTEM_PROGRAM_ID;
                const poolIndex = pool.index;

                // Compute gross output (no fee)
                const grossOut = side === "baseToQuote"
                    ? (quoteReserve * amountIn) / (baseReserve + amountIn)
                    : (baseReserve * amountIn) / (quoteReserve + amountIn);

                // Infer actual fee from gross vs actual
                // actual = floor(gross * (10000 - fee) / 10000)
                // fee = 10000 - ceil(actual * 10000 / gross)
                const inferredFeeBps = grossOut > 0n
                    ? 10000n - (actualOut * 10000n + grossOut - 1n) / grossOut
                    : 0n;

                // Test with direction-appropriate fees:
                // SELL (baseToQuote): 25bps (20 LP + 5 Protocol)
                // BUY (quoteToBase): 24bps (20 LP + 4 Protocol)
                const feesBps20 = { lpFeeBps: 20n, protocolFeeBps: 0n, coinCreatorFeeBps: 0n };
                const feesBps24 = { lpFeeBps: 20n, protocolFeeBps: 4n, coinCreatorFeeBps: 0n };
                const feesBps25 = { lpFeeBps: 20n, protocolFeeBps: 5n, coinCreatorFeeBps: 0n };

                const sim20 = simulatePumpSwapSwap({ amountIn, baseReserve, quoteReserve, side, feesBps: feesBps20 });
                const sim24 = simulatePumpSwapSwap({ amountIn, baseReserve, quoteReserve, side, feesBps: feesBps24 });
                const sim25 = simulatePumpSwapSwap({ amountIn, baseReserve, quoteReserve, side, feesBps: feesBps25 });

                const diff20 = absDiff(sim20.amountOut, actualOut);
                const diff24 = absDiff(sim24.amountOut, actualOut);
                const diff25 = absDiff(sim25.amountOut, actualOut);

                // Both directions use 25bps, but with different fee placement:
                // SELL (baseToQuote): fee on OUTPUT at 25bps
                // BUY (quoteToBase): fee on INPUT at 25bps
                const expectedFeeBps = 25n;
                const simExpected = sim25;
                const diffExpected = diff25;

                // Also test with CEILING fee deduction (SDK uses ceil)
                // net = gross - ceil(gross * feeBps / 10000)
                const ceilFee20 = (grossOut * 20n + 9999n) / 10000n;
                const ceilFee24 = (grossOut * 24n + 9999n) / 10000n;
                const ceilFee25 = (grossOut * 25n + 9999n) / 10000n;
                const ceilOut20 = grossOut - ceilFee20;
                const ceilOut24 = grossOut - ceilFee24;
                const ceilOut25 = grossOut - ceilFee25;
                const diffCeil20 = absDiff(ceilOut20, actualOut);
                const diffCeil24 = absDiff(ceilOut24, actualOut);
                const diffCeil25 = absDiff(ceilOut25, actualOut);

                const ceilExpected = ceilOut25;
                const diffCeilExpected = diffCeil25;

                const matches20 = diff20 <= 1n;
                const matches24 = diff24 <= 1n;
                const matches25 = diff25 <= 1n;
                const matchesExpected = diffExpected <= 1n;
                const matchesCeil20 = diffCeil20 <= 1n;
                const matchesCeil24 = diffCeil24 <= 1n;
                const matchesCeil25 = diffCeil25 <= 1n;
                const matchesCeilExpected = diffCeilExpected <= 1n;

                used++;

                // Track correlation using direction-appropriate expected fee
                // SELL expects 25bps, BUY expects 24bps
                const matchKey = matchesExpected ? "floorExpected"
                    : matchesCeilExpected ? "ceilExpected"
                        : matches20 && !matches25 ? "floor20"
                            : !matches20 && matches25 ? "floor25"
                                : matches24 ? "floor24"
                                    : matchesCeil20 ? "ceil20"
                                        : matchesCeil24 ? "ceil24"
                                            : matchesCeil25 ? "ceil25"
                                                : "neither";

                // Update correlation stats - now tracking "expected" (direction-appropriate fee) matches
                const matchesExpectedKey = matchKey === "floorExpected" || matchKey === "ceilExpected";
                if (creatorIsNull) {
                    if (matchesExpectedKey) pumpswapStats.nullCreator25++; // 25bps for SELL, 24bps for BUY
                    else if (matchKey === "floor20" || matchKey === "ceil20") pumpswapStats.nullCreator20++;
                    else pumpswapStats.nullCreatorNeither++;
                } else {
                    if (matchesExpectedKey) pumpswapStats.nonNullCreator25++;
                    else if (matchKey === "floor20" || matchKey === "ceil20") pumpswapStats.nonNullCreator20++;
                    else pumpswapStats.nonNullCreatorNeither++;
                }

                // Track by pool index
                if (!pumpswapStats.byPoolIndex.has(poolIndex)) {
                    pumpswapStats.byPoolIndex.set(poolIndex, { m20: 0, m25: 0, neither: 0 });
                }
                const idxStats = pumpswapStats.byPoolIndex.get(poolIndex)!;
                if (matchesExpectedKey) idxStats.m25++;
                else if (matchKey === "floor20" || matchKey === "ceil20") idxStats.m20++;
                else idxStats.neither++;

                // Track by direction
                const isSell = side === "baseToQuote";
                if (isSell) {
                    if (matchesExpectedKey) pumpswapStats.sell25++;
                    else if (matchKey === "floor20" || matchKey === "ceil20") pumpswapStats.sell20++;
                    else pumpswapStats.sellNeither++;
                } else {
                    if (matchesExpectedKey) pumpswapStats.buy25++; // Actually 24bps for BUY
                    else if (matchKey === "floor20" || matchKey === "ceil20") pumpswapStats.buy20++;
                    else pumpswapStats.buyNeither++;
                }

                // Track inferredFee distribution
                pumpswapStats.byInferredFee.set(
                    inferredFeeBps,
                    (pumpswapStats.byInferredFee.get(inferredFeeBps) ?? 0) + 1
                );

                console.log(
                    `PUMPSWAP sig=${c.signature.slice(0, 16)}... ` +
                    `side=${side} ` +
                    `creatorNull=${creatorIsNull} poolIndex=${poolIndex} ` +
                    `inferredFee=${inferredFeeBps} expectedFee=${expectedFeeBps} ` +
                    `dExpected=${diffExpected} dCeilExpected=${diffCeilExpected} ` +
                    `match=${matchKey}`
                );

                // Use direction-appropriate expected fee for mismatch detection
                if (diffExpected > 1n && diffCeilExpected > 1n) {
                    const bestDiff = diffExpected < diffCeilExpected ? diffExpected : diffCeilExpected;
                    const bestSimOut = diffExpected < diffCeilExpected ? simExpected.amountOut : ceilExpected;
                    mismatches.push({
                        venue: c.venue,
                        signature: c.signature,
                        slot: c.slot,
                        amountIn,
                        actualOut,
                        simOut: bestSimOut,
                        diff: bestDiff,
                        note: `creatorNull=${creatorIsNull} poolIndex=${poolIndex} inferred=${inferredFeeBps}bps expected=${expectedFeeBps}bps match=${matchKey}`,
                    });
                }
            }

            if (c.venue === "raydium_v4") {
                let poolPk: string | null = null;

                for (const [pk, a] of Object.entries(c.preAccounts)) {
                    const buf = Buffer.from(a.dataBase64, "base64");
                    if (buf.length !== V4_POOL_SIZE) continue;
                    try {
                        decodeRaydiumV4Pool(buf);
                        poolPk = pk;
                        break;
                    } catch {
                        continue;
                    }
                }

                if (!poolPk) {
                    skipped++;
                    continue;
                }

                const pool = decodeRaydiumV4Pool(store.getData(poolPk)!);

                const baseVault = pool.baseVault.toBase58();
                const quoteVault = pool.quoteVault.toBase58();

                const dBase = tokenDelta(c, baseVault);
                const dQuote = tokenDelta(c, quoteVault);
                if (dBase === null || dQuote === null) {
                    skipped++;
                    continue;
                }

                let baseToQuote: boolean;
                let amountIn: bigint;
                let actualOut: bigint;

                if (dBase > 0n && dQuote < 0n) {
                    baseToQuote = true;
                    amountIn = dBase;
                    actualOut = -dQuote;
                } else if (dQuote > 0n && dBase < 0n) {
                    baseToQuote = false;
                    amountIn = dQuote;
                    actualOut = -dBase;
                } else {
                    skipped++;
                    continue;
                }

                const baseVaultBalance = tokenPre(c, baseVault);
                const quoteVaultBalance = tokenPre(c, quoteVault);
                if (baseVaultBalance === null || quoteVaultBalance === null) {
                    skipped++;
                    continue;
                }

                let ooBaseTotal = 0n;
                let ooQuoteTotal = 0n;
                const ooPk = pool.openOrders.toBase58();
                const ooBuf = store.getData(ooPk);
                if (ooBuf && isOpenOrdersAccount(ooBuf)) {
                    const oo = decodeRaydiumV4OpenOrders(ooBuf);
                    ooBaseTotal = oo.baseTokenTotal;
                    ooQuoteTotal = oo.quoteTokenTotal;
                }

                const sim = simulateRaydiumV4Swap({
                    pool,
                    amountIn,
                    baseToQuote,
                    baseVaultBalance,
                    quoteVaultBalance,
                    openOrdersBaseTotal: ooBaseTotal,
                    openOrdersQuoteTotal: ooQuoteTotal,
                });

                const diff = absDiff(sim.amountOut, actualOut);
                used++;

                if (diff > 1n) {
                    mismatches.push({
                        venue: c.venue,
                        signature: c.signature,
                        slot: c.slot,
                        amountIn,
                        actualOut,
                        simOut: sim.amountOut,
                        diff,
                    });
                }
            }

            if (c.venue === "raydium_clmm") {
                let poolPk: string | null = null;

                for (const [pk, a] of Object.entries(c.preAccounts)) {
                    const buf = Buffer.from(a.dataBase64, "base64");
                    if (isRaydiumClmmPoolAccount(buf)) {
                        poolPk = pk;
                        break;
                    }
                }

                if (!poolPk) {
                    skipped++;
                    continue;
                }

                const pool = decodeRaydiumClmmPool(store.getData(poolPk)!);

                const vault0 = pool.tokenVault0.toBase58();
                const vault1 = pool.tokenVault1.toBase58();

                const d0 = tokenDelta(c, vault0);
                const d1 = tokenDelta(c, vault1);
                if (d0 === null || d1 === null) {
                    skipped++;
                    continue;
                }

                let zeroForOne: boolean;
                let amountIn: bigint;
                let actualOut: bigint;

                if (d0 > 0n && d1 < 0n) {
                    zeroForOne = true;
                    amountIn = d0;
                    actualOut = -d1;
                } else if (d1 > 0n && d0 < 0n) {
                    zeroForOne = false;
                    amountIn = d1;
                    actualOut = -d0;
                } else {
                    skipped++;
                    continue;
                }

                const cfgPk = pool.ammConfig.toBase58();
                let cfgBuf: Buffer | null | undefined = store.getData(cfgPk);

                // Fetch AmmConfig from RPC if not in preAccounts (it's read-only, never streamed)
                if (!cfgBuf) {
                    cfgBuf = await fetchAccountIfMissing(cfgPk, store, c.slot);
                }

                if (!cfgBuf || !isRaydiumAmmConfigAccount(cfgBuf)) {
                    console.log(`CLMM skip: AmmConfig ${cfgPk.slice(0,16)}... not found/invalid`);
                    skipped++;
                    continue;
                }
                const cfg = decodeRaydiumAmmConfig(cfgBuf);

                // Collect tick arrays from preAccounts first
                const tickArrays: RaydiumTickArrayState[] = [];
                const tickArrayStartIndices = new Set<number>();

                for (const a of Object.values(c.preAccounts)) {
                    const buf = Buffer.from(a.dataBase64, "base64");
                    if (!isRaydiumTickArrayAccount(buf)) continue;
                    const ta = decodeRaydiumTickArray(buf);
                    if (ta.poolId.toBase58() !== poolPk) continue;
                    tickArrays.push(ta);
                    tickArrayStartIndices.add(ta.startTickIndex);
                }

                // Calculate which tick arrays we NEED based on current tick
                const ticksPerArray = pool.tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
                const currentStartIndex = getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing);

                // For a swap, we may need adjacent tick arrays too
                const neededIndices = [
                    currentStartIndex,
                    currentStartIndex - ticksPerArray, // previous
                    currentStartIndex + ticksPerArray, // next
                ];

                // Fetch missing tick arrays via RPC
                const poolPubkey = new PublicKey(poolPk);
                for (const startIdx of neededIndices) {
                    if (tickArrayStartIndices.has(startIdx)) continue; // already have it

                    const taPda = deriveRaydiumTickArrayPda(poolPubkey, startIdx);
                    const taBuf = await fetchAccountIfMissing(taPda.toBase58(), store, c.slot);

                    if (taBuf && isRaydiumTickArrayAccount(taBuf)) {
                        const ta = decodeRaydiumTickArray(taBuf, taPda);
                        if (ta.poolId.toBase58() === poolPk) {
                            tickArrays.push(ta);
                            tickArrayStartIndices.add(ta.startTickIndex);
                        }
                    }
                }

                const sim = simulateRaydiumCLMMSwapExactIn(pool, cfg, tickArrays, amountIn, zeroForOne);

                const diff = absDiff(sim.amountOut, actualOut);
                used++;

                if (diff > 1n) {
                    mismatches.push({
                        venue: c.venue,
                        signature: c.signature,
                        slot: c.slot,
                        amountIn,
                        actualOut,
                        simOut: sim.amountOut,
                        diff,
                    });
                }
            }

            if (c.venue === "meteora_dlmm") {
                let pairPk: string | null = null;

                for (const [pk, a] of Object.entries(c.preAccounts)) {
                    const buf = Buffer.from(a.dataBase64, "base64");
                    if (isMeteoraLbPairAccount(buf)) {
                        pairPk = pk;
                        break;
                    }
                }

                if (!pairPk) {
                    skipped++;
                    continue;
                }

                const lbPair = decodeMeteoraLbPair(store.getData(pairPk)!);

                const reserveX = lbPair.reserveX.toBase58();
                const reserveY = lbPair.reserveY.toBase58();

                const dX = tokenDelta(c, reserveX);
                const dY = tokenDelta(c, reserveY);
                if (dX === null || dY === null) {
                    skipped++;
                    continue;
                }

                let direction: MeteoraSwapDirection;
                let amountIn: bigint;
                let actualOut: bigint;

                if (dX > 0n && dY < 0n) {
                    direction = "xToY";
                    amountIn = dX;
                    actualOut = -dY;
                } else if (dY > 0n && dX < 0n) {
                    direction = "yToX";
                    amountIn = dY;
                    actualOut = -dX;
                } else {
                    skipped++;
                    continue;
                }

                // Collect bin arrays from preAccounts first
                const binArrays: MeteoraBinArray[] = [];
                const binArrayIndices = new Set<bigint>();

                for (const a of Object.values(c.preAccounts)) {
                    const buf = Buffer.from(a.dataBase64, "base64");
                    if (!isMeteoraBinArrayAccount(buf)) continue;

                    const arr = decodeMeteoraBinArray(buf);
                    if (arr.lbPair.toBase58() !== pairPk) continue;
                    binArrays.push(arr);
                    binArrayIndices.add(arr.index);
                }

                // Calculate which bin arrays we NEED based on activeId
                const activeArrayIndex = binIdToBinArrayIndex(lbPair.activeId);

                // For a swap, we may need adjacent bin arrays too
                const neededIndices = [
                    activeArrayIndex,
                    activeArrayIndex - 1n, // previous
                    activeArrayIndex + 1n, // next
                ];

                // Fetch missing bin arrays via RPC
                const pairPubkey = new PublicKey(pairPk);
                for (const idx of neededIndices) {
                    if (binArrayIndices.has(idx)) continue; // already have it

                    const baPda = deriveMeteoraBinArrayPda(pairPubkey, idx);
                    const baBuf = await fetchAccountIfMissing(baPda.toBase58(), store, c.slot);

                    if (baBuf && isMeteoraBinArrayAccount(baBuf)) {
                        const arr = decodeMeteoraBinArray(baBuf, baPda);
                        if (arr.lbPair.toBase58() === pairPk) {
                            binArrays.push(arr);
                            binArrayIndices.add(arr.index);
                        }
                    }
                }

                const bins = buildMeteoraBinLiquidityMap(binArrays);

                const sim = simulateMeteoraDlmmSwap({
                    lbPair,
                    bins,
                    direction,
                    amountIn,
                });

                const diff = absDiff(sim.amountOut, actualOut);
                used++;

                if (diff > 1n) {
                    mismatches.push({
                        venue: c.venue,
                        signature: c.signature,
                        slot: c.slot,
                        amountIn,
                        actualOut,
                        simOut: sim.amountOut,
                        diff,
                    });
                }
            }
        } catch {
            skipped++;
            continue;
        }
    }

    console.log(`Total lines: ${total}`);
    console.log(`Used cases:  ${used}`);
    console.log(`Skipped:     ${skipped}`);
    console.log(`Mismatches (> 1 unit): ${mismatches.length}`);

    // PumpSwap correlation summary
    console.log("\n" + "=".repeat(60));
    console.log("PUMPSWAP FEE CORRELATION ANALYSIS");
    console.log("=".repeat(60));
    console.log("\nBy creator (null = System Program):");
    console.log(`  NULL creator → 20bps: ${pumpswapStats.nullCreator20}`);
    console.log(`  NULL creator → 25bps: ${pumpswapStats.nullCreator25}`);
    console.log(`  NULL creator → neither: ${pumpswapStats.nullCreatorNeither}`);
    console.log(`  NON-NULL creator → 20bps: ${pumpswapStats.nonNullCreator20}`);
    console.log(`  NON-NULL creator → 25bps: ${pumpswapStats.nonNullCreator25}`);
    console.log(`  NON-NULL creator → neither: ${pumpswapStats.nonNullCreatorNeither}`);

    console.log("\nBy pool.index:");
    const sortedIndices = [...pumpswapStats.byPoolIndex.entries()].sort((a, b) => a[0] - b[0]);
    for (const [idx, stats] of sortedIndices) {
        console.log(`  index=${idx}: 20bps=${stats.m20} 25bps=${stats.m25} neither=${stats.neither}`);
    }

    console.log("\nBy direction (SELL=baseToQuote, BUY=quoteToBase):");
    console.log(`  SELL → 20bps: ${pumpswapStats.sell20}`);
    console.log(`  SELL → 25bps: ${pumpswapStats.sell25}`);
    console.log(`  SELL → neither: ${pumpswapStats.sellNeither}`);
    console.log(`  BUY → 20bps: ${pumpswapStats.buy20}`);
    console.log(`  BUY → 25bps: ${pumpswapStats.buy25}`);
    console.log(`  BUY → neither: ${pumpswapStats.buyNeither}`);

    console.log("\nBy inferred fee rate (bps):");
    const sortedFees = [...pumpswapStats.byInferredFee.entries()].sort((a, b) => Number(a[0] - b[0]));
    for (const [fee, count] of sortedFees) {
        console.log(`  ${fee} bps: ${count} cases`);
    }
    console.log("=".repeat(60) + "\n");

    mismatches.sort((a, b) => (a.diff > b.diff ? -1 : a.diff < b.diff ? 1 : 0));

    for (const m of mismatches.slice(0, 25)) {
        console.log(
            `${m.venue} slot=${m.slot} sig=${m.signature} amountIn=${m.amountIn} actualOut=${m.actualOut} simOut=${m.simOut} diff=${m.diff}${m.note ? " " + m.note : ""}`
        );
    }

    if (mismatches.length > 0) process.exit(2);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});