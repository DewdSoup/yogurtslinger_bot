// src/regression/runRegression.ts
//
// Offline regression harness for:
//   - PumpSwap
//   - Raydium V4
//   - Raydium CLMM
//   - Meteora DLMM
//
// This version derives swap direction + amounts from *pool vault deltas*
// (tokenChanges) instead of trusting the high‑level `input` / `output`
// fields. That makes the comparisons line up with what the on‑chain programs
// actually see at the pool level.
//
// It keeps everything BigInt and reuses your existing decoders + sims.

import * as fs from "fs";
import * as path from "path";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";

import {
    InMemoryAccountStore,
    type AccountSnapshot,
    type AccountUpdate,
    type PubkeyStr,
} from "../state/accountStore";

import { decodeSplTokenAccountAmount } from "../decoders/splToken";

// PumpSwap decoders
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

// PumpSwap sim + fees
import {
    type PumpSwapFeesBps,
    feesFromGlobalConfig,
} from "../sim/pumpswapFees";
import {
    simulatePumpSwapSwap,
    type PumpSwapSide,
} from "../sim/pumpswapSim";

// Raydium V4 decoders + sim
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

// Raydium CLMM decoders + sim
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

// Meteora DLMM decoders + sim
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

// ----------------- swap_decode JSON types -----------------

export type ProgramTag =
    | "pumpswap"
    | "raydium_v4"
    | "raydium_clmm"
    | "meteora_dlmm";

export interface SwapTokenAmount {
    mint: string;
    amount: string;
    decimals?: number;
    uiAmount?: number;
    account: string;
    owner: string;
}

export interface RawAccountState {
    owner: string;
    lamports: number | string;
    executable: boolean;
    rentEpoch: number | string;
    data: string;
    dataEncoding: string; // "base64"
    dataLength: number;
    role?: string;
    [k: string]: unknown;
}

// Token / SOL change records from swap_decode
export interface TokenChange {
    accountIndex: number;
    account: string;
    mint: string;
    owner: string;
    programId: string;
    preAmount: string;
    postAmount: string;
    change: string;
    decimals: number;
    uiChange?: number;
}

export interface SolChange {
    accountIndex: number;
    account: string;
    preBalance: number;
    postBalance: number;
    change: number;
    changeSol: number;
}

export interface SwapCaseRecord {
    signature: string;
    slot: number;
    blockTime?: number;
    blockTimeISO?: string;

    program: ProgramTag;
    programId: string;

    category?: string;
    sizeSol?: number;
    edgeCases?: unknown[];

    input: SwapTokenAmount;
    output: SwapTokenAmount;

    fee?: number;
    feeSol?: number;
    computeUnitsConsumed?: number;

    accounts?: string[];
    // Pre-swap account states keyed by pubkey
    accountStates: Record<string, RawAccountState>;
    accountRoles: Record<string, string>;
    accountStateCount?: number;

    tokenChanges?: TokenChange[];
    solChanges?: SolChange[];

    [k: string]: unknown;
}

export interface SwapDataset {
    collectedAt?: string;
    program: ProgramTag;
    programId: string;
    cases: SwapCaseRecord[];
}

// ----------------- Regression result types -----------------

export type Venue = "PumpSwap" | "RaydiumV4" | "RaydiumCLMM" | "MeteoraDLMM";

export interface CaseRegressionResult {
    venue: Venue;
    signature: string;
    slot: number;

    amountIn: bigint;
    actualAmountOut: bigint;
    simulatedAmountOut: bigint;

    absDiff: bigint;
    diffSigned: bigint;
    notes?: string;
}

export interface CaseErrorResult {
    venue: Venue;
    signature: string;
    slot: number;
    error: string;
}

export interface VenueStats {
    venue: Venue;
    programId: string;

    totalCases: number;
    simulatedCases: number;
    exactMatches: number;
    offByOne: number;
    offByMore: number;
    errorCases: number;

    diffHistogram: Map<string, number>;
    mismatchExamples: CaseRegressionResult[];
    errorExamples: CaseErrorResult[];
}

// ----------------- generic helpers -----------------

function parseBigInt(
    value: string | number | bigint | undefined | null
): bigint {
    if (value === null || value === undefined) return 0n;
    if (typeof value === "bigint") return value;
    if (typeof value === "string") {
        if (value.length === 0) return 0n;
        return BigInt(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`Non‑finite number: ${value}`);
        }
        return BigInt(Math.trunc(value));
    }
    throw new Error(`Unsupported type for BigInt: ${typeof value}`);
}

function bigIntAbs(x: bigint): bigint {
    return x < 0n ? -x : x;
}

function decodeAccountData(raw: RawAccountState): Buffer {
    if (!raw.data) return Buffer.alloc(0);
    if (!raw.dataEncoding || raw.dataEncoding === "base64") {
        return Buffer.from(raw.data, "base64");
    }
    if (raw.dataEncoding === "hex") {
        return Buffer.from(raw.data, "hex");
    }
    return Buffer.from(raw.data, "utf8");
}

function buildAccountStoreSnapshot(
    c: SwapCaseRecord
): { store: InMemoryAccountStore; snapshot: AccountSnapshot } {
    const store = new InMemoryAccountStore();
    const slot = c.slot;

    const updates: AccountUpdate[] = [];

    for (const [pubkey, state] of Object.entries(c.accountStates)) {
        const dataBuf = decodeAccountData(state);
        const lamports = parseBigInt(state.lamports);
        const rentEpoch = parseBigInt(state.rentEpoch);

        const update: AccountUpdate = {
            pubkey: pubkey as PubkeyStr,
            data: dataBuf,
            slot,
            writeVersion: 0n,
            owner: state.owner,
            lamports,
            executable: !!state.executable,
            rentEpoch,
        };
        updates.push(update);
    }

    for (const u of updates) {
        store.apply(u);
    }

    const snapshot = store.snapshot(Object.keys(c.accountStates));
    return { store, snapshot };
}

function firstKeyByRole(
    accountRoles: Record<string, string>,
    predicate: (role: string) => boolean
): string | undefined {
    for (const [pk, r] of Object.entries(accountRoles)) {
        if (predicate(r)) return pk;
    }
    return undefined;
}

function findTokenChange(
    c: SwapCaseRecord,
    account: string
): TokenChange | undefined {
    const changes = c.tokenChanges;
    if (!changes) return undefined;
    return changes.find((ch) => ch.account === account);
}

function tokenPrePostDelta(
    c: SwapCaseRecord,
    account: string,
    fallbackData?: Buffer
): { pre: bigint; post: bigint; delta: bigint } {
    const change = findTokenChange(c, account);
    if (change) {
        const pre = parseBigInt(change.preAmount);
        const post = parseBigInt(change.postAmount);
        return { pre, post, delta: post - pre };
    }
    if (!fallbackData) {
        return { pre: 0n, post: 0n, delta: 0n };
    }
    const pre = decodeSplTokenAccountAmount(fallbackData);
    return { pre, post: pre, delta: 0n };
}

// ----------------- PumpSwap regression -----------------

function findPumpSwapPool(
    c: SwapCaseRecord,
    snapshot: AccountSnapshot
): { poolPubkey: string; pool: PumpSwapPoolState } {
    const rolePk = firstKeyByRole(c.accountRoles, (r) =>
        r === "pumpswap_bonding_curve" ||
        r === "pumpswap_associated_bonding_curve"
    );

    if (rolePk) {
        const view = snapshot.get(rolePk as PubkeyStr);
        if (view && !view.deleted && view.data.length > 0) {
            if (isPumpSwapPoolAccount(view.data)) {
                const pool = decodePumpSwapPool(view.data, new PublicKey(rolePk));
                return { poolPubkey: rolePk, pool };
            }
        }
    }

    for (const [pk] of Object.entries(c.accountStates)) {
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isPumpSwapPoolAccount(view.data)) continue;
        const pool = decodePumpSwapPool(view.data, new PublicKey(pk));
        return { poolPubkey: pk, pool };
    }

    throw new Error("PumpSwap pool account not found in accountStates");
}

function findPumpSwapGlobalConfig(
    c: SwapCaseRecord,
    snapshot: AccountSnapshot
): PumpSwapGlobalConfig | undefined {
    const globalPk = firstKeyByRole(
        c.accountRoles,
        (r) => r === "pumpswap_global"
    );

    if (globalPk) {
        const view = snapshot.get(globalPk as PubkeyStr);
        if (view && !view.deleted && view.data.length > 0) {
            if (isPumpSwapGlobalConfigAccount(view.data)) {
                return decodePumpSwapGlobalConfig(
                    view.data,
                    new PublicKey(globalPk)
                );
            }
        }
    }

    for (const [pk] of Object.entries(c.accountStates)) {
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isPumpSwapGlobalConfigAccount(view.data)) continue;
        return decodePumpSwapGlobalConfig(view.data, new PublicKey(pk));
    }

    return undefined;
}

function simulatePumpSwapCase(
    c: SwapCaseRecord,
    snapshot: AccountSnapshot
): CaseRegressionResult {
    const venue: Venue = "PumpSwap";

    // User-view I/O from JSON
    const amountIn = parseBigInt(c.input.amount);
    const actualAmountOut = parseBigInt(c.output.amount);

    const { poolPubkey, pool } = findPumpSwapPool(c, snapshot);
    const globalConfig = findPumpSwapGlobalConfig(c, snapshot);

    let feesBps: PumpSwapFeesBps;
    if (globalConfig) {
        feesBps = feesFromGlobalConfig(globalConfig);
    } else {
        feesBps = {
            lpFeeBps: 0n,
            protocolFeeBps: 0n,
            coinCreatorFeeBps: 0n,
        };
    }

    const baseVaultPk = pool.poolBaseTokenAccount.toBase58();
    const quoteVaultPk = pool.poolQuoteTokenAccount.toBase58();

    const baseVaultView = snapshot.get(baseVaultPk as PubkeyStr);
    const quoteVaultView = snapshot.get(quoteVaultPk as PubkeyStr);

    if (!baseVaultView || baseVaultView.deleted) {
        throw new Error(
            `PumpSwap base vault missing for pool ${poolPubkey}: ${baseVaultPk}`
        );
    }
    if (!quoteVaultView || quoteVaultView.deleted) {
        throw new Error(
            `PumpSwap quote vault missing for pool ${poolPubkey}: ${quoteVaultPk}`
        );
    }

    const baseToken = tokenPrePostDelta(c, baseVaultPk, baseVaultView.data);
    const quoteToken = tokenPrePostDelta(c, quoteVaultPk, quoteVaultView.data);

    const baseReserveBefore = baseToken.pre;
    const quoteReserveBefore = quoteToken.pre;

    const baseDelta = baseToken.delta;
    const quoteDelta = quoteToken.delta;

    let side: PumpSwapSide | null = null;

    // Pool vault deltas drive direction:
    //   baseDelta > 0, quoteDelta < 0  => pool gained base (SOL), lost quote (token)  => user swapped base -> quote
    //   quoteDelta > 0, baseDelta < 0  => pool gained quote (token), lost base (SOL)  => user swapped quote -> base
    if (baseDelta > 0n && quoteDelta < 0n) {
        side = "baseToQuote";
    } else if (quoteDelta > 0n && baseDelta < 0n) {
        side = "quoteToBase";
    } else {
        // Fallback: infer from input/output mints
        const baseMintStr = pool.baseMint.toBase58();
        const quoteMintStr = pool.quoteMint.toBase58();
        const inputMint = c.input.mint;
        const outputMint = c.output.mint;

        if (inputMint === baseMintStr && outputMint === quoteMintStr) {
            side = "baseToQuote";
        } else if (inputMint === quoteMintStr && outputMint === baseMintStr) {
            side = "quoteToBase";
        } else if (inputMint === baseMintStr) {
            side = "baseToQuote";
        } else if (inputMint === quoteMintStr) {
            side = "quoteToBase";
        } else {
            side = null;
        }
    }

    let simulatedAmountOut: bigint;

    if (side === null) {
        // Ambiguous: try both directions and pick the closer to actualAmountOut
        const simBaseToQuote = simulatePumpSwapSwap({
            amountIn,
            baseReserve: baseReserveBefore,
            quoteReserve: quoteReserveBefore,
            side: "baseToQuote",
            feesBps,
        });
        const simQuoteToBase = simulatePumpSwapSwap({
            amountIn,
            baseReserve: baseReserveBefore,
            quoteReserve: quoteReserveBefore,
            side: "quoteToBase",
            feesBps,
        });

        const diffBase = bigIntAbs(simBaseToQuote.amountOut - actualAmountOut);
        const diffQuote = bigIntAbs(simQuoteToBase.amountOut - actualAmountOut);

        const chosen =
            diffBase <= diffQuote ? simBaseToQuote : simQuoteToBase;
        simulatedAmountOut = chosen.amountOut;
    } else {
        const quote = simulatePumpSwapSwap({
            amountIn,
            baseReserve: baseReserveBefore,
            quoteReserve: quoteReserveBefore,
            side,
            feesBps,
        });
        simulatedAmountOut = quote.amountOut;
    }

    const diffSigned = simulatedAmountOut - actualAmountOut;
    const absDiff = bigIntAbs(diffSigned);

    return {
        venue,
        signature: c.signature,
        slot: c.slot,
        amountIn,
        actualAmountOut,
        simulatedAmountOut,
        absDiff,
        diffSigned,
    };
}

// ----------------- Raydium V4 regression -----------------

function simulateRaydiumV4Case(
    c: SwapCaseRecord,
    snapshot: AccountSnapshot
): CaseRegressionResult {
    const venue: Venue = "RaydiumV4";

    const amountIn = parseBigInt(c.input.amount);
    const actualAmountOut = parseBigInt(c.output.amount);

    const raydiumProgramStr = RAYDIUM_V4_PROGRAM.toBase58();

    let poolPubkey: string | undefined;
    let pool: RaydiumV4PoolState | undefined;

    for (const [pk, st] of Object.entries(c.accountStates)) {
        if (st.owner !== raydiumProgramStr) continue;
        if (st.dataLength !== V4_POOL_SIZE) continue;

        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isRaydiumV4PoolAccount(view.data)) continue;

        poolPubkey = pk;
        pool = decodeRaydiumV4Pool(view.data, new PublicKey(pk));
        break;
    }

    if (!pool || !poolPubkey) {
        throw new Error("Raydium V4 pool account not found in accountStates");
    }

    let openOrders: RaydiumV4OpenOrdersState | undefined;
    for (const [pk, st] of Object.entries(c.accountStates)) {
        if (st.dataLength !== OPEN_ORDERS_SIZE) continue;
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isOpenOrdersAccount(view.data)) continue;

        openOrders = decodeRaydiumV4OpenOrders(view.data, new PublicKey(pk));
        break;
    }

    const baseVaultPk = pool.baseVault.toBase58();
    const quoteVaultPk = pool.quoteVault.toBase58();

    const baseVaultView = snapshot.get(baseVaultPk as PubkeyStr);
    const quoteVaultView = snapshot.get(quoteVaultPk as PubkeyStr);

    if (!baseVaultView || baseVaultView.deleted) {
        throw new Error(
            `Raydium V4 base vault missing for pool ${poolPubkey}: ${baseVaultPk}`
        );
    }
    if (!quoteVaultView || quoteVaultView.deleted) {
        throw new Error(
            `Raydium V4 quote vault missing for pool ${poolPubkey}: ${quoteVaultPk}`
        );
    }

    const baseToken = tokenPrePostDelta(c, baseVaultPk, baseVaultView.data);
    const quoteToken = tokenPrePostDelta(c, quoteVaultPk, quoteVaultView.data);

    const baseVaultAmount = baseToken.pre;
    const quoteVaultAmount = quoteToken.pre;

    const baseDelta = baseToken.delta;
    const quoteDelta = quoteToken.delta;

    let baseToQuote: boolean | null = null;

    if (baseDelta > 0n && quoteDelta < 0n) {
        // Pool gained base, lost quote => user swapped base -> quote
        baseToQuote = true;
    } else if (quoteDelta > 0n && baseDelta < 0n) {
        // Pool gained quote, lost base => user swapped quote -> base
        baseToQuote = false;
    } else {
        // Fallback to JSON input/output mints if deltas are inconclusive
        const baseMintStr = pool.baseMint.toBase58();
        const quoteMintStr = pool.quoteMint.toBase58();
        const inputMint = c.input.mint;
        const outputMint = c.output.mint;

        if (inputMint === baseMintStr && outputMint === quoteMintStr) {
            baseToQuote = true;
        } else if (inputMint === quoteMintStr && outputMint === baseMintStr) {
            baseToQuote = false;
        } else if (inputMint === baseMintStr) {
            baseToQuote = true;
        } else if (inputMint === quoteMintStr) {
            baseToQuote = false;
        } else {
            baseToQuote = null;
        }
    }

    const openOrdersBase = openOrders?.baseTokenTotal ?? 0n;
    const openOrdersQuote = openOrders?.quoteTokenTotal ?? 0n;

    let simulatedAmountOut: bigint;

    if (baseToQuote === null) {
        const simBaseToQuote = simulateRaydiumV4Swap({
            pool,
            amountIn,
            baseToQuote: true,
            baseVaultBalance: baseVaultAmount,
            quoteVaultBalance: quoteVaultAmount,
            openOrdersBaseTotal: openOrdersBase,
            openOrdersQuoteTotal: openOrdersQuote,
        });

        const simQuoteToBase = simulateRaydiumV4Swap({
            pool,
            amountIn,
            baseToQuote: false,
            baseVaultBalance: baseVaultAmount,
            quoteVaultBalance: quoteVaultAmount,
            openOrdersBaseTotal: openOrdersBase,
            openOrdersQuoteTotal: openOrdersQuote,
        });

        const diffBaseToQuote = bigIntAbs(
            simBaseToQuote.amountOut - actualAmountOut
        );
        const diffQuoteToBase = bigIntAbs(
            simQuoteToBase.amountOut - actualAmountOut
        );

        const chosen =
            diffBaseToQuote <= diffQuoteToBase
                ? simBaseToQuote
                : simQuoteToBase;
        simulatedAmountOut = chosen.amountOut;
    } else {
        const sim = simulateRaydiumV4Swap({
            pool,
            amountIn,
            baseToQuote,
            baseVaultBalance: baseVaultAmount,
            quoteVaultBalance: quoteVaultAmount,
            openOrdersBaseTotal: openOrdersBase,
            openOrdersQuoteTotal: openOrdersQuote,
        });
        simulatedAmountOut = sim.amountOut;
    }

    const diffSigned = simulatedAmountOut - actualAmountOut;
    const absDiff = bigIntAbs(diffSigned);

    return {
        venue,
        signature: c.signature,
        slot: c.slot,
        amountIn,
        actualAmountOut,
        simulatedAmountOut,
        absDiff,
        diffSigned,
    };
}

// ----------------- Raydium CLMM regression -----------------

function simulateRaydiumCLMMCase(
    c: SwapCaseRecord,
    snapshot: AccountSnapshot
): CaseRegressionResult {
    const venue: Venue = "RaydiumCLMM";

    const amountIn = parseBigInt(c.input.amount);
    const actualAmountOut = parseBigInt(c.output.amount);

    const clmmProgramStr = RAYDIUM_CLMM_PROGRAM_ID.toBase58();

    let poolPubkey: string | undefined;
    let pool: RaydiumCLMMPoolState | undefined;

    for (const [pk, st] of Object.entries(c.accountStates)) {
        if (st.owner !== clmmProgramStr) continue;
        if (st.dataLength !== RAYDIUM_CLMM_POOL_SIZE) continue;

        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isRaydiumClmmPoolAccount(view.data)) continue;

        poolPubkey = pk;
        pool = decodeRaydiumClmmPool(view.data, new PublicKey(pk));
        break;
    }

    if (!pool || !poolPubkey) {
        throw new Error("Raydium CLMM pool account not found in accountStates");
    }

    let config: RaydiumAmmConfigState | undefined;
    for (const [pk, st] of Object.entries(c.accountStates)) {
        if (st.owner !== clmmProgramStr) continue;
        if (st.dataLength < RAYDIUM_AMM_CONFIG_SIZE) continue;

        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isRaydiumAmmConfigAccount(view.data)) continue;

        config = decodeRaydiumAmmConfig(view.data, new PublicKey(pk));
        break;
    }

    if (!config) {
        throw new Error("Raydium CLMM AmmConfig not found in accountStates");
    }

    const tickArrays: RaydiumTickArrayState[] = [];
    const poolIdStr =
        (pool as any).address && (pool as any).address instanceof PublicKey
            ? (pool as any).address.toBase58()
            : poolPubkey;

    for (const [pk, st] of Object.entries(c.accountStates)) {
        if (st.dataLength !== RAYDIUM_TICK_ARRAY_SIZE) continue;

        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;
        if (!isRaydiumTickArrayAccount(view.data)) continue;

        const ta = decodeRaydiumTickArray(view.data, new PublicKey(pk));
        if (ta.poolId.toBase58() !== poolIdStr) continue;
        tickArrays.push(ta);
    }

    if (tickArrays.length === 0) {
        throw new Error(
            "Raydium CLMM TickArray accounts for pool not found in accountStates"
        );
    }

    const token0MintStr = (pool as any).tokenMint0.toBase58();
    const token1MintStr = (pool as any).tokenMint1.toBase58();

    const token0VaultPk = (pool as any).tokenVault0.toBase58();
    const token1VaultPk = (pool as any).tokenVault1.toBase58();

    const token0View = snapshot.get(token0VaultPk as PubkeyStr);
    const token1View = snapshot.get(token1VaultPk as PubkeyStr);

    if (!token0View || token0View.deleted || !token1View || token1View.deleted) {
        throw new Error("Raydium CLMM vault accounts missing from snapshot");
    }

    const token0 = tokenPrePostDelta(c, token0VaultPk, token0View.data);
    const token1 = tokenPrePostDelta(c, token1VaultPk, token1View.data);

    const delta0 = token0.delta;
    const delta1 = token1.delta;

    let zeroForOne: boolean | null = null;

    if (delta0 > 0n && delta1 < 0n) {
        // Pool gained token0, lost token1 => user swapped token0 -> token1
        zeroForOne = true;
    } else if (delta1 > 0n && delta0 < 0n) {
        // Pool gained token1, lost token0 => user swapped token1 -> token0
        zeroForOne = false;
    } else {
        // Fallback: infer from JSON input/output
        const inputMint = c.input.mint;
        const outputMint = c.output.mint;

        if (inputMint === token0MintStr && outputMint === token1MintStr) {
            zeroForOne = true;
        } else if (inputMint === token1MintStr && outputMint === token0MintStr) {
            zeroForOne = false;
        } else if (inputMint === token0MintStr) {
            zeroForOne = true;
        } else if (inputMint === token1MintStr) {
            zeroForOne = false;
        } else {
            zeroForOne = null;
        }
    }

    let simulatedAmountOut: bigint;

    if (zeroForOne === null) {
        const sim0to1 = simulateRaydiumCLMMSwapExactIn(
            pool,
            config,
            tickArrays,
            amountIn,
            true
        );
        const sim1to0 = simulateRaydiumCLMMSwapExactIn(
            pool,
            config,
            tickArrays,
            amountIn,
            false
        );

        const diff0 = bigIntAbs(sim0to1.amountOut - actualAmountOut);
        const diff1 = bigIntAbs(sim1to0.amountOut - actualAmountOut);

        const chosen = diff0 <= diff1 ? sim0to1 : sim1to0;
        simulatedAmountOut = chosen.amountOut;
    } else {
        const sim = simulateRaydiumCLMMSwapExactIn(
            pool,
            config,
            tickArrays,
            amountIn,
            zeroForOne
        );
        simulatedAmountOut = sim.amountOut;
    }

    const diffSigned = simulatedAmountOut - actualAmountOut;
    const absDiff = bigIntAbs(diffSigned);

    return {
        venue,
        signature: c.signature,
        slot: c.slot,
        amountIn,
        actualAmountOut,
        simulatedAmountOut,
        absDiff,
        diffSigned,
    };
}

// ----------------- Meteora DLMM regression -----------------

function collectMeteoraPool(
    c: SwapCaseRecord,
    snapshot: AccountSnapshot
): {
    lbPair: MeteoraLbPairState;
    bins: Map<number, MeteoraBinLiquidity>;
} {
    const dlmmProgramStr = METEORA_DLMM_PROGRAM_ID.toBase58();

    let lbPair: MeteoraLbPairState | undefined;
    const binArrays: MeteoraBinArray[] = [];

    for (const [pk, st] of Object.entries(c.accountStates)) {
        if (st.owner !== dlmmProgramStr) continue;
        const view = snapshot.get(pk as PubkeyStr);
        if (!view || view.deleted || view.data.length === 0) continue;

        const data = view.data;

        if (!lbPair && isMeteoraLbPairAccount(data)) {
            lbPair = decodeMeteoraLbPair(data, new PublicKey(pk));
            continue;
        }

        if (isMeteoraBinArrayAccount(data)) {
            const ba = decodeMeteoraBinArray(data, new PublicKey(pk));
            binArrays.push(ba);
        }
    }

    if (!lbPair) {
        throw new Error("Meteora LbPair account not found in accountStates");
    }
    if (binArrays.length === 0) {
        throw new Error("Meteora BinArray accounts not found in accountStates");
    }

    const bins = buildMeteoraBinLiquidityMap(binArrays);
    return { lbPair, bins };
}

function simulateMeteoraCase(
    c: SwapCaseRecord,
    snapshot: AccountSnapshot
): CaseRegressionResult {
    const venue: Venue = "MeteoraDLMM";

    const amountIn = parseBigInt(c.input.amount);
    const actualAmountOut = parseBigInt(c.output.amount);

    const { lbPair, bins } = collectMeteoraPool(c, snapshot);

    const tokenXMintStr = lbPair.tokenXMint.toBase58();
    const tokenYMintStr = lbPair.tokenYMint.toBase58();

    const vaultX = lbPair.reserveX.toBase58();
    const vaultY = lbPair.reserveY.toBase58();

    const vaultXView = snapshot.get(vaultX as PubkeyStr);
    const vaultYView = snapshot.get(vaultY as PubkeyStr);

    if (!vaultXView || vaultXView.deleted || !vaultYView || vaultYView.deleted) {
        throw new Error("Meteora DLMM reserve vaults missing in snapshot");
    }

    const tokX = tokenPrePostDelta(c, vaultX, vaultXView.data);
    const tokY = tokenPrePostDelta(c, vaultY, vaultYView.data);

    const deltaX = tokX.delta;
    const deltaY = tokY.delta;

    let direction: MeteoraSwapDirection | null = null;

    if (deltaX > 0n && deltaY < 0n) {
        // Pool gained X, lost Y => user swapped X -> Y
        direction = "xToY";
    } else if (deltaY > 0n && deltaX < 0n) {
        // Pool gained Y, lost X => user swapped Y -> X
        direction = "yToX";
    } else {
        // Fallback: infer from JSON input/output mints
        const inputMint = c.input.mint;
        const outputMint = c.output.mint;

        if (inputMint === tokenXMintStr && outputMint === tokenYMintStr) {
            direction = "xToY";
        } else if (inputMint === tokenYMintStr && outputMint === tokenXMintStr) {
            direction = "yToX";
        } else if (inputMint === tokenXMintStr) {
            direction = "xToY";
        } else if (inputMint === tokenYMintStr) {
            direction = "yToX";
        } else {
            direction = null;
        }
    }

    const feeMode: MeteoraFeeMode = "output";

    let simulatedAmountOut: bigint;

    if (direction === null) {
        const simX = simulateMeteoraDlmmSwap({
            lbPair,
            bins,
            direction: "xToY",
            amountIn,
            feeMode,
        });
        const simY = simulateMeteoraDlmmSwap({
            lbPair,
            bins,
            direction: "yToX",
            amountIn,
            feeMode,
        });

        const diffX = bigIntAbs(simX.amountOut - actualAmountOut);
        const diffY = bigIntAbs(simY.amountOut - actualAmountOut);

        const chosen = diffX <= diffY ? simX : simY;
        simulatedAmountOut = chosen.amountOut;
    } else {
        const sim = simulateMeteoraDlmmSwap({
            lbPair,
            bins,
            direction,
            amountIn,
            feeMode,
        });
        simulatedAmountOut = sim.amountOut;
    }

    const diffSigned = simulatedAmountOut - actualAmountOut;
    const absDiff = bigIntAbs(diffSigned);

    return {
        venue,
        signature: c.signature,
        slot: c.slot,
        amountIn,
        actualAmountOut,
        simulatedAmountOut,
        absDiff,
        diffSigned,
    };
}

// ----------------- stats helpers -----------------

function initVenueStats(venue: Venue, programId: string): VenueStats {
    return {
        venue,
        programId,
        totalCases: 0,
        simulatedCases: 0,
        exactMatches: 0,
        offByOne: 0,
        offByMore: 0,
        errorCases: 0,
        diffHistogram: new Map<string, number>(),
        mismatchExamples: [],
        errorExamples: [],
    };
}

function recordCaseResult(
    stats: VenueStats,
    r: CaseRegressionResult
): void {
    stats.totalCases += 1;
    stats.simulatedCases += 1;

    const abs = r.absDiff;

    if (abs === 0n) {
        stats.exactMatches += 1;
    } else if (abs === 1n) {
        stats.offByOne += 1;
    } else {
        stats.offByMore += 1;
        const key = abs.toString();
        stats.diffHistogram.set(key, (stats.diffHistogram.get(key) ?? 0) + 1);
        if (stats.mismatchExamples.length < 5) {
            stats.mismatchExamples.push(r);
        }
    }
}

function recordCaseError(
    stats: VenueStats,
    err: CaseErrorResult
): void {
    stats.totalCases += 1;
    stats.errorCases += 1;
    if (stats.errorExamples.length < 5) {
        stats.errorExamples.push(err);
    }
}

// ----------------- dataset driver -----------------

function runDatasetRegression(
    datasetPath: string,
    expectedProgram: ProgramTag,
    venue: Venue
): VenueStats {
    const raw = fs.readFileSync(datasetPath, "utf8");
    const dataset: SwapDataset = JSON.parse(raw);

    if (dataset.program !== expectedProgram) {
        throw new Error(
            `Dataset ${path.basename(
                datasetPath
            )} program mismatch: expected ${expectedProgram}, got ${dataset.program}`
        );
    }

    const stats = initVenueStats(venue, dataset.programId);

    for (const c of dataset.cases) {
        const { snapshot } = buildAccountStoreSnapshot(c);

        try {
            let result: CaseRegressionResult;

            switch (venue) {
                case "PumpSwap":
                    result = simulatePumpSwapCase(c, snapshot);
                    break;
                case "RaydiumV4":
                    result = simulateRaydiumV4Case(c, snapshot);
                    break;
                case "RaydiumCLMM":
                    result = simulateRaydiumCLMMCase(c, snapshot);
                    break;
                case "MeteoraDLMM":
                    result = simulateMeteoraCase(c, snapshot);
                    break;
                default:
                    throw new Error(`Unsupported venue: ${venue}`);
            }

            recordCaseResult(stats, result);
        } catch (e: any) {
            const msg = e instanceof Error ? e.message : String(e);
            recordCaseError(stats, {
                venue,
                signature: c.signature,
                slot: c.slot,
                error: msg,
            });
        }
    }

    return stats;
}

// ----------------- CLI / top‑level -----------------

function resolveSwapDecodeDir(): string {
    const argPath = process.argv[2];
    if (argPath && argPath.length > 0) {
        return path.resolve(argPath);
    }

    const envPath = process.env.SWAP_DECODE_DIR;
    if (envPath && envPath.length > 0) {
        return path.resolve(envPath);
    }

    const cwd = process.cwd();
    const candidate1 = path.join(cwd, "swap_decode");
    const candidate2 = path.join(cwd, "swap_decode", "swap_decode");

    if (fs.existsSync(candidate2)) return candidate2;
    if (fs.existsSync(candidate1)) return candidate1;

    const here = __dirname;
    const candidate3 = path.join(here, "..", "..", "swap_decode");
    const candidate4 = path.join(here, "..", "..", "swap_decode", "swap_decode");

    if (fs.existsSync(candidate4)) return candidate4;
    if (fs.existsSync(candidate3)) return candidate3;

    throw new Error(
        "Unable to locate swap_decode directory. " +
        "Pass it as CLI arg, set SWAP_DECODE_DIR, or create ./swap_decode."
    );
}

function printVenueStats(stats: VenueStats): void {
    const {
        venue,
        programId,
        totalCases,
        simulatedCases,
        exactMatches,
        offByOne,
        offByMore,
        errorCases,
        diffHistogram,
        mismatchExamples,
        errorExamples,
    } = stats;

    console.log("==================================================");
    console.log(`Venue: ${venue}`);
    console.log(`Program ID: ${programId}`);
    console.log(`Total cases:     ${totalCases}`);
    console.log(`Simulated cases: ${simulatedCases}`);
    console.log(`Exact matches:   ${exactMatches}`);
    console.log(`Off‑by‑1:        ${offByOne}`);
    console.log(`Off‑by‑>=2:      ${offByMore}`);
    console.log(`Errors:          ${errorCases}`);

    if (diffHistogram.size > 0) {
        const sorted = [...diffHistogram.entries()].sort(([a], [b]) => {
            const aa = BigInt(a);
            const bb = BigInt(b);
            if (aa < bb) return -1;
            if (aa > bb) return 1;
            return 0;
        });

        console.log("Abs diff histogram (delta -> count):");
        for (const [delta, count] of sorted.slice(0, 10)) {
            console.log(`  ${delta}: ${count}`);
        }
        if (sorted.length > 10) {
            console.log("  ... (truncated)");
        }
    }

    if (mismatchExamples.length > 0) {
        console.log("\nExample mismatches:");
        for (const m of mismatchExamples) {
            console.log(
                `  sig=${m.signature} slot=${m.slot} ` +
                `amountIn=${m.amountIn.toString()} ` +
                `actualOut=${m.actualAmountOut.toString()} ` +
                `simOut=${m.simulatedAmountOut.toString()} ` +
                `diff=${m.diffSigned.toString()}`
            );
        }
    }

    if (errorExamples.length > 0) {
        console.log("\nExample errors:");
        for (const e of errorExamples) {
            console.log(
                `  sig=${e.signature} slot=${e.slot} error=${e.error}`
            );
        }
    }

    console.log("==================================================\n");
}

export function runRegressionAll(): void {
    const root = resolveSwapDecodeDir();

    const datasets: {
        filename: string;
        program: ProgramTag;
        venue: Venue;
    }[] = [
            {
                filename: "pumpswap_swap.json",
                program: "pumpswap",
                venue: "PumpSwap",
            },
            {
                filename: "raydium_v4_swaps.json",
                program: "raydium_v4",
                venue: "RaydiumV4",
            },
            {
                filename: "raydium_clmm_swaps.json",
                program: "raydium_clmm",
                venue: "RaydiumCLMM",
            },
            {
                filename: "meteora_dlmm_swaps.json",
                program: "meteora_dlmm",
                venue: "MeteoraDLMM",
            },
        ];

    console.log(`Using swap_decode directory: ${root}\n`);

    for (const ds of datasets) {
        const fullPath = path.join(root, ds.filename);
        if (!fs.existsSync(fullPath)) {
            console.warn(
                `Dataset file missing: ${fullPath} — skipping ${ds.venue}`
            );
            continue;
        }

        const stats = runDatasetRegression(fullPath, ds.program, ds.venue);
        printVenueStats(stats);
    }
}

// Node-style entrypoint guard (safe under ts-node)
declare const require: any;
declare const module: any;

if (typeof require !== "undefined" && typeof module !== "undefined") {
    if (require.main === module) {
        try {
            runRegressionAll();
        } catch (e: any) {
            const msg = e instanceof Error ? e.stack ?? e.message : String(e);
            // eslint-disable-next-line no-console
            console.error("Regression run failed:", msg);
            process.exit(1);
        }
    }
}
