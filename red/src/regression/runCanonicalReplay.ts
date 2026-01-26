// src/regression/runCanonicalReplay.ts
//
// Canonical replay harness for validator-sourced NDJSON captures.
// Goal: surface decoder/simulator mismatches (no hot-path logic).
// Input format follows src/capture/canonicalTypes.ts (pre/post bytes, token/lamport deltas).
//
// Usage:
//   pnpm exec ts-node src/regression/runCanonicalReplay.ts ./data/canonical_cases.ndjson
//
// This is intentionally strict: missing accounts or ambiguous direction => error.

import fs from "fs";
import path from "path";
import readline from "readline";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";

import type { CanonicalSwapCase, RawAccountStateJson } from "../capture/canonicalTypes";

import {
    InMemoryAccountStore,
    type AccountSnapshot,
    type AccountUpdate,
    type PubkeyStr,
} from "../state/accountStore";

import { decodeSplTokenAccountAmount } from "../decoders/splToken";

// PumpSwap
import {
    isPumpSwapPoolAccount,
    decodePumpSwapPool,
    type PumpSwapPoolState,
} from "../decoders/pumpswapPool";
import {
    isPumpSwapGlobalConfigAccount,
    decodePumpSwapGlobalConfig,
    type PumpSwapGlobalConfig,
} from "../decoders/pumpswapGlobalConfig";
import { feesFromGlobalConfig } from "../sim/pumpswapFees";
import { simulatePumpSwapSwap, type PumpSwapSide } from "../sim/pumpswapSim";

// Raydium V4
import {
    RAYDIUM_V4_PROGRAM,
    V4_POOL_SIZE,
    isRaydiumV4PoolAccount,
    decodeRaydiumV4Pool,
    type RaydiumV4PoolState,
} from "../decoders/raydiumV4Pool";
import {
    OPEN_ORDERS_SIZE,
    isOpenOrdersAccount,
    decodeRaydiumV4OpenOrders,
    type RaydiumV4OpenOrdersState,
} from "../decoders/raydiumV4OpenOrders";
import { simulateRaydiumV4Swap } from "../sim/raydiumV4Sim";

// Raydium CLMM
import {
    RAYDIUM_CLMM_PROGRAM_ID,
    RAYDIUM_CLMM_POOL_SIZE,
    isRaydiumClmmPoolAccount,
    decodeRaydiumClmmPool,
    type RaydiumCLMMPoolState,
} from "../decoders/raydiumCLMMPool";
import {
    RAYDIUM_AMM_CONFIG_SIZE,
    isRaydiumAmmConfigAccount,
    decodeRaydiumAmmConfig,
    type RaydiumAmmConfigState,
} from "../decoders/raydiumAmmConfig";
import {
    RAYDIUM_TICK_ARRAY_SIZE,
    isRaydiumTickArrayAccount,
    decodeRaydiumTickArray,
    type RaydiumTickArrayState,
} from "../decoders/raydiumTickArray";
import { simulateRaydiumCLMMSwapExactIn } from "../sim/raydiumCLMMSim";

// Meteora DLMM
import {
    METEORA_DLMM_PROGRAM_ID,
    isMeteoraLbPairAccount,
    decodeMeteoraLbPair,
    type MeteoraLbPairState,
} from "../decoders/meteoraLbPair";
import {
    isMeteoraBinArrayAccount,
    decodeMeteoraBinArray,
    buildMeteoraBinLiquidityMap,
    type MeteoraBinArray,
    type MeteoraBinLiquidity,
} from "../decoders/meteoraBinArray";
import {
    simulateMeteoraDlmmSwap,
    type MeteoraSwapDirection,
    type MeteoraFeeMode,
} from "../sim/meteoraDLMMSim";

// ----------------- helpers -----------------

function parseBigInt(value: string | number | bigint | undefined | null): bigint {
    if (value === null || value === undefined) return 0n;
    if (typeof value === "bigint") return value;
    if (typeof value === "string") {
        if (value.length === 0) return 0n;
        return BigInt(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error(`Non-finite number: ${value}`);
        return BigInt(Math.trunc(value));
    }
    throw new Error(`Unsupported type for BigInt: ${typeof value}`);
}

function decodeAccountData(raw: RawAccountStateJson): Buffer {
    if (!raw.dataBase64) return Buffer.alloc(0);
    return Buffer.from(raw.dataBase64, "base64");
}

function buildSnapshot(c: CanonicalSwapCase): { store: InMemoryAccountStore; snapshot: AccountSnapshot } {
    const store = new InMemoryAccountStore();
    const slot = c.slot;

    const updates: AccountUpdate[] = [];
    for (const [pubkey, state] of Object.entries(c.preAccounts)) {
        const dataBuf = decodeAccountData(state);
        const lamports = parseBigInt(state.lamports);
        const rentEpoch = parseBigInt(state.rentEpoch);

        updates.push({
            pubkey: pubkey as PubkeyStr,
            data: dataBuf,
            slot,
            writeVersion: 0n,
            owner: state.owner,
            lamports,
            executable: !!state.executable,
            rentEpoch,
        });
    }

    for (const u of updates) store.apply(u);
    const snapshot = store.snapshot(Object.keys(c.preAccounts));
    return { store, snapshot };
}

type TokenDelta = { pre: bigint; post: bigint; delta: bigint };

function tokenPrePostDelta(c: CanonicalSwapCase, account: string, snapshot: AccountSnapshot): TokenDelta {
    const tb = c.tokenBalances[account];
    if (tb) {
        const pre = parseBigInt(tb.preAmount);
        const post = parseBigInt(tb.postAmount);
        return { pre, post, delta: post - pre };
    }

    // Fallback to pre/post account raw bytes if present
    const preView = snapshot.get(account as PubkeyStr);
    const preAmount = preView ? decodeSplTokenAccountAmount(preView.data) : 0n;

    const postRaw = c.postAccounts?.[account];
    const postAmount = postRaw ? decodeSplTokenAccountAmount(decodeAccountData(postRaw)) : preAmount;

    return { pre: preAmount, post: postAmount, delta: postAmount - preAmount };
}

function bigIntAbs(x: bigint): bigint {
    return x < 0n ? -x : x;
}

// ----------------- venue simulators -----------------

function simulatePumpSwapCase(c: CanonicalSwapCase, snapshot: AccountSnapshot) {
    let poolPubkey: string | undefined;
    let pool: PumpSwapPoolState | undefined;

    for (const [pk] of Object.entries(c.preAccounts)) {
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isPumpSwapPoolAccount(view.data)) continue;
        poolPubkey = pk;
        pool = decodePumpSwapPool(view.data, new PublicKey(pk));
        break;
    }
    if (!pool || !poolPubkey) throw new Error("PumpSwap pool not found");

    let globalConfig: PumpSwapGlobalConfig | undefined;
    for (const [pk] of Object.entries(c.preAccounts)) {
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isPumpSwapGlobalConfigAccount(view.data)) continue;
        globalConfig = decodePumpSwapGlobalConfig(view.data, new PublicKey(pk));
        break;
    }

    const feesBps = globalConfig ? feesFromGlobalConfig(globalConfig) : { lpFeeBps: 0n, protocolFeeBps: 0n, coinCreatorFeeBps: 0n };

    const baseVaultPk = pool.poolBaseTokenAccount.toBase58();
    const quoteVaultPk = pool.poolQuoteTokenAccount.toBase58();

    const base = tokenPrePostDelta(c, baseVaultPk, snapshot);
    const quote = tokenPrePostDelta(c, quoteVaultPk, snapshot);

    let side: PumpSwapSide | null = null;
    if (base.delta > 0n && quote.delta < 0n) side = "baseToQuote";
    else if (quote.delta > 0n && base.delta < 0n) side = "quoteToBase";

    if (side === null) throw new Error("PumpSwap direction ambiguous (vault deltas did not diverge)");

    const amountIn = side === "baseToQuote" ? base.delta : quote.delta;
    const actualOut = side === "baseToQuote" ? -quote.delta : -base.delta;

    const quoteRes = simulatePumpSwapSwap({
        amountIn,
        baseReserve: base.pre,
        quoteReserve: quote.pre,
        side,
        feesBps,
    });

    return {
        venue: "PumpSwap",
        amountIn,
        actualOut,
        simulatedOut: quoteRes.amountOut,
        diff: quoteRes.amountOut - actualOut,
    };
}

function simulateRaydiumV4Case(c: CanonicalSwapCase, snapshot: AccountSnapshot) {
    const raydiumProgramStr = RAYDIUM_V4_PROGRAM.toBase58();

    let poolPubkey: string | undefined;
    let pool: RaydiumV4PoolState | undefined;
    for (const [pk, st] of Object.entries(c.preAccounts)) {
        if (st.owner !== raydiumProgramStr) continue;
        if (st.dataBase64 && Buffer.from(st.dataBase64, "base64").length !== V4_POOL_SIZE) continue;
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isRaydiumV4PoolAccount(view.data)) continue;
        poolPubkey = pk;
        pool = decodeRaydiumV4Pool(view.data, new PublicKey(pk));
        break;
    }
    if (!pool || !poolPubkey) throw new Error("Raydium V4 pool not found");

    let openOrders: RaydiumV4OpenOrdersState | undefined;
    for (const [pk] of Object.entries(c.preAccounts)) {
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length !== OPEN_ORDERS_SIZE) continue;
        if (!isOpenOrdersAccount(view.data)) continue;
        openOrders = decodeRaydiumV4OpenOrders(view.data, new PublicKey(pk));
        break;
    }

    const baseVaultPk = pool.baseVault.toBase58();
    const quoteVaultPk = pool.quoteVault.toBase58();

    const base = tokenPrePostDelta(c, baseVaultPk, snapshot);
    const quote = tokenPrePostDelta(c, quoteVaultPk, snapshot);

    let baseToQuote: boolean | null = null;
    if (base.delta > 0n && quote.delta < 0n) baseToQuote = true;
    else if (quote.delta > 0n && base.delta < 0n) baseToQuote = false;
    if (baseToQuote === null) throw new Error("Raydium V4 direction ambiguous");

    const openOrdersBase = openOrders?.baseTokenTotal ?? 0n;
    const openOrdersQuote = openOrders?.quoteTokenTotal ?? 0n;

    const amountIn = baseToQuote ? base.delta : quote.delta;
    const actualOut = baseToQuote ? -quote.delta : -base.delta;

    const sim = simulateRaydiumV4Swap({
        pool,
        amountIn,
        baseToQuote,
        baseVaultBalance: base.pre,
        quoteVaultBalance: quote.pre,
        openOrdersBaseTotal: openOrdersBase,
        openOrdersQuoteTotal: openOrdersQuote,
    });

    return {
        venue: "RaydiumV4",
        amountIn,
        actualOut,
        simulatedOut: sim.amountOut,
        diff: sim.amountOut - actualOut,
    };
}

function simulateRaydiumCLMMCase(c: CanonicalSwapCase, snapshot: AccountSnapshot) {
    const clmmProgramStr = RAYDIUM_CLMM_PROGRAM_ID.toBase58();

    let poolPubkey: string | undefined;
    let pool: RaydiumCLMMPoolState | undefined;
    for (const [pk, st] of Object.entries(c.preAccounts)) {
        if (st.owner !== clmmProgramStr) continue;
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length !== RAYDIUM_CLMM_POOL_SIZE) continue;
        if (!isRaydiumClmmPoolAccount(view.data)) continue;
        poolPubkey = pk;
        pool = decodeRaydiumClmmPool(view.data, new PublicKey(pk));
        break;
    }
    if (!pool || !poolPubkey) throw new Error("Raydium CLMM pool not found");

    let config: RaydiumAmmConfigState | undefined;
    for (const [pk, st] of Object.entries(c.preAccounts)) {
        if (st.owner !== clmmProgramStr) continue;
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length < RAYDIUM_AMM_CONFIG_SIZE) continue;
        if (!isRaydiumAmmConfigAccount(view.data)) continue;
        config = decodeRaydiumAmmConfig(view.data, new PublicKey(pk));
        break;
    }
    if (!config) throw new Error("Raydium CLMM AmmConfig not found");

    const tickArrays: RaydiumTickArrayState[] = [];
    const poolIdStr = (pool as any).address && (pool as any).address instanceof PublicKey
        ? (pool as any).address.toBase58()
        : poolPubkey;

    for (const [pk] of Object.entries(c.preAccounts)) {
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length !== RAYDIUM_TICK_ARRAY_SIZE) continue;
        if (!isRaydiumTickArrayAccount(view.data)) continue;
        const ta = decodeRaydiumTickArray(view.data, new PublicKey(pk));
        if (ta.poolId.toBase58() !== poolIdStr) continue;
        tickArrays.push(ta);
    }
    if (tickArrays.length === 0) throw new Error("Raydium CLMM tick arrays missing");

    const token0VaultPk = (pool as any).tokenVault0.toBase58();
    const token1VaultPk = (pool as any).tokenVault1.toBase58();

    const tok0 = tokenPrePostDelta(c, token0VaultPk, snapshot);
    const tok1 = tokenPrePostDelta(c, token1VaultPk, snapshot);

    let zeroForOne: boolean | null = null;
    if (tok0.delta > 0n && tok1.delta < 0n) zeroForOne = true;
    else if (tok1.delta > 0n && tok0.delta < 0n) zeroForOne = false;
    if (zeroForOne === null) throw new Error("Raydium CLMM direction ambiguous");

    const amountIn = zeroForOne ? tok0.delta : tok1.delta;
    const actualOut = zeroForOne ? -tok1.delta : -tok0.delta;

    const sim = simulateRaydiumCLMMSwapExactIn(pool, config, tickArrays, amountIn, zeroForOne);

    return {
        venue: "RaydiumCLMM",
        amountIn,
        actualOut,
        simulatedOut: sim.amountOut,
        diff: sim.amountOut - actualOut,
    };
}

function collectMeteoraPool(c: CanonicalSwapCase, snapshot: AccountSnapshot): {
    lbPair: MeteoraLbPairState;
    bins: Map<number, MeteoraBinLiquidity>;
} {
    const dlmmProgramStr = METEORA_DLMM_PROGRAM_ID.toBase58();

    let lbPair: MeteoraLbPairState | undefined;
    const binArrays: MeteoraBinArray[] = [];

    for (const [pk] of Object.entries(c.preAccounts)) {
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (view.meta.owner !== dlmmProgramStr) continue;

        if (!lbPair && isMeteoraLbPairAccount(view.data)) {
            lbPair = decodeMeteoraLbPair(view.data, new PublicKey(pk));
            continue;
        }

        if (isMeteoraBinArrayAccount(view.data)) {
            binArrays.push(decodeMeteoraBinArray(view.data, new PublicKey(pk)));
        }
    }

    if (!lbPair) throw new Error("Meteora LbPair not found");
    if (binArrays.length === 0) throw new Error("Meteora bin arrays missing");

    const bins = buildMeteoraBinLiquidityMap(binArrays);
    return { lbPair, bins };
}

function simulateMeteoraCase(c: CanonicalSwapCase, snapshot: AccountSnapshot) {
    const { lbPair, bins } = collectMeteoraPool(c, snapshot);

    const vaultX = lbPair.reserveX.toBase58();
    const vaultY = lbPair.reserveY.toBase58();

    const tokX = tokenPrePostDelta(c, vaultX, snapshot);
    const tokY = tokenPrePostDelta(c, vaultY, snapshot);

    let direction: MeteoraSwapDirection | null = null;
    if (tokX.delta > 0n && tokY.delta < 0n) direction = "xToY";
    else if (tokY.delta > 0n && tokX.delta < 0n) direction = "yToX";
    if (direction === null) throw new Error("Meteora direction ambiguous");

    const amountIn = direction === "xToY" ? tokX.delta : tokY.delta;
    const actualOut = direction === "xToY" ? -tokY.delta : -tokX.delta;

    const feeMode: MeteoraFeeMode = "output";
    const sim = simulateMeteoraDlmmSwap({
        lbPair,
        bins,
        direction,
        amountIn,
        feeMode,
    });

    return {
        venue: "MeteoraDLMM",
        amountIn,
        actualOut,
        simulatedOut: sim.amountOut,
        diff: sim.amountOut - actualOut,
    };
}

// ----------------- runner -----------------

type Venue = "PumpSwap" | "RaydiumV4" | "RaydiumCLMM" | "MeteoraDLMM";

type Stats = {
    venue: Venue;
    total: number;
    simulated: number;
    exact: number;
    tolerated: number;
    mismatches: number;
    errors: number;
    samples: { sig: string; slot: number; diff: bigint; venue: Venue; note: string }[];
};

const venues: Venue[] = ["PumpSwap", "RaydiumV4", "RaydiumCLMM", "MeteoraDLMM"];

const DEFAULT_TOLERANCE_BPS = 0n; // adjust later if needed
const DEFAULT_TOLERANCE_ABS = 0n;

function withinTolerance(simulated: bigint, actual: bigint): boolean {
    const diff = simulated - actual;
    const abs = bigIntAbs(diff);
    if (abs === 0n) return true;

    // absolute cap
    if (DEFAULT_TOLERANCE_ABS > 0n && abs <= DEFAULT_TOLERANCE_ABS) return true;

    if (DEFAULT_TOLERANCE_BPS > 0n && actual !== 0n) {
        const bps = (abs * 10_000n) / bigIntAbs(actual);
        if (bps <= DEFAULT_TOLERANCE_BPS) return true;
    }

    return false;
}

async function runReplay(filePath: string) {
    const statsMap = new Map<Venue, Stats>();
    for (const v of venues) {
        statsMap.set(v, {
            venue: v,
            total: 0,
            simulated: 0,
            exact: 0,
            tolerated: 0,
            mismatches: 0,
            errors: 0,
            samples: [],
        });
    }

    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let c: CanonicalSwapCase;
        try {
            c = JSON.parse(trimmed) as CanonicalSwapCase;
        } catch (e: any) {
            console.error("Skipping invalid JSON line:", e?.message ?? e);
            continue;
        }

        if (!venues.includes(c.venue as Venue)) continue;
        const stats = statsMap.get(c.venue as Venue)!;
        stats.total += 1;

        const { snapshot } = buildSnapshot(c);

        try {
            let res:
                | ReturnType<typeof simulatePumpSwapCase>
                | ReturnType<typeof simulateRaydiumV4Case>
                | ReturnType<typeof simulateRaydiumCLMMCase>
                | ReturnType<typeof simulateMeteoraCase>;

            switch (c.venue) {
                case "pumpswap":
                    res = simulatePumpSwapCase(c, snapshot);
                    break;
                case "raydium_v4":
                    res = simulateRaydiumV4Case(c, snapshot);
                    break;
                case "raydium_clmm":
                    res = simulateRaydiumCLMMCase(c, snapshot);
                    break;
                case "meteora_dlmm":
                    res = simulateMeteoraCase(c, snapshot);
                    break;
                default:
                    throw new Error(`Unsupported venue: ${c.venue}`);
            }

            stats.simulated += 1;
            const abs = bigIntAbs(res.diff);
            if (abs === 0n) {
                stats.exact += 1;
            } else if (withinTolerance(res.simulatedOut, res.actualOut)) {
                stats.tolerated += 1;
            } else {
                stats.mismatches += 1;
                if (stats.samples.length < 10) {
                    stats.samples.push({
                        sig: c.signature,
                        slot: c.slot,
                        diff: res.diff,
                        venue: stats.venue,
                        note: `sim=${res.simulatedOut.toString()} actual=${res.actualOut.toString()}`,
                    });
                }
            }
        } catch (e: any) {
            stats.errors += 1;
            if (stats.samples.length < 10) {
                stats.samples.push({
                    sig: c.signature,
                    slot: c.slot,
                    diff: 0n,
                    venue: stats.venue,
                    note: `error=${e instanceof Error ? e.message : String(e)}`,
                });
            }
        }
    }

    for (const v of venues) {
        const s = statsMap.get(v)!;
        console.log("==================================================");
        console.log(`Venue: ${v}`);
        console.log(`Total cases:     ${s.total}`);
        console.log(`Simulated:       ${s.simulated}`);
        console.log(`Exact:           ${s.exact}`);
        console.log(`Tolerated:       ${s.tolerated}`);
        console.log(`Mismatches:      ${s.mismatches}`);
        console.log(`Errors:          ${s.errors}`);
        if (s.samples.length > 0) {
            console.log("Samples:");
            for (const sm of s.samples) {
                console.log(
                    `  sig=${sm.sig} slot=${sm.slot} diff=${sm.diff.toString()} note=${sm.note}`
                );
            }
        }
        console.log("==================================================\n");
    }
}

// Node-style entrypoint guard
declare const require: any;
declare const module: any;

if (typeof require !== "undefined" && typeof module !== "undefined") {
    if (require.main === module) {
        const filePath = process.argv[2];
        if (!filePath) {
            console.error("Usage: pnpm exec ts-node src/regression/runCanonicalReplay.ts <cases.ndjson>");
            process.exit(1);
        }
        const abs = path.resolve(filePath);
        if (!fs.existsSync(abs)) {
            console.error(`File not found: ${abs}`);
            process.exit(1);
        }
        runReplay(abs).catch((e) => {
            console.error("Replay failed:", e instanceof Error ? e.stack ?? e.message : String(e));
            process.exit(1);
        });
    }
}
