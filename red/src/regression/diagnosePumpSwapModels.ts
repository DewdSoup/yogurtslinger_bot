// src/regression/diagnosePumpSwapModels.ts
//
// Deterministic PumpSwap fee/model inference from canonical_cases.ndjson.
//
// Ground truth is derived strictly from vault deltas (pre/post token balances), never from any
// high-level aggregator fields.
//
// We evaluate multiple concrete fee-placement models and infer the implied fee-bps range that is
// consistent with integer floor behavior, then check which configured fee bps (from global config
// and/or fee_config) matches those ranges.

import fs from "fs";

import type { CanonicalSwapCase, TokenBalanceChangeJson } from "../capture/canonicalTypes";

import {
    decodePumpSwapPool,
    isPumpSwapPoolAccount,
    PUMPSWAP_PROGRAM_ID,
    type PumpSwapPoolState,
} from "../decoders/pumpswapPool";

import {
    decodePumpSwapGlobalConfig,
    isPumpSwapGlobalConfigAccount,
    type PumpSwapGlobalConfig,
} from "../decoders/pumpswapGlobalConfig";

import {
    decodeFeeConfig,
    deriveFeeConfigPda,
    isFeeConfigAccount,
    selectTierFeesLowerBound,
    selectTierFeesUpperBound,
    tradeFeeBps,
    type PumpFeesFeeConfig,
    type PumpFeesFeesBps,
} from "../decoders/pumpFeesFeeConfig";

const BPS = 10_000n;

type PumpSwapSide = "baseToQuote" | "quoteToBase";

type FeeRange = { min: bigint; max: bigint };

function ceilDiv(a: bigint, b: bigint): bigint {
    if (b === 0n) throw new Error("ceilDiv div0");
    return (a + b - 1n) / b;
}

function floorDiv(a: bigint, b: bigint): bigint {
    if (b === 0n) throw new Error("floorDiv div0");
    return a / b;
}

function cpOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
    if (amountIn <= 0n) return 0n;
    if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
    return (reserveOut * amountIn) / (reserveIn + amountIn);
}

function getTokenBalance(c: CanonicalSwapCase, pk: string): TokenBalanceChangeJson | undefined {
    return c.tokenBalances[pk];
}

function feeRangeFromGrossAndActual(gross: bigint, actual: bigint): FeeRange | null {
    // actual = floor(gross * (BPS - fee) / BPS)
    if (gross <= 0n) return null;
    if (actual < 0n) return null;
    if (actual > gross) return null;

    // Let t = (BPS - fee). Then:
    // actual*BPS <= gross*t <= (actual+1)*BPS - 1
    const tMin = ceilDiv(actual * BPS, gross);
    const tMax = floorDiv(((actual + 1n) * BPS - 1n), gross);
    if (tMin > tMax) return null;

    const feeMin = BPS - tMax;
    const feeMax = BPS - tMin;
    return { min: feeMin, max: feeMax };
}

function feeRangeFromGrossAndNetRange(gross: bigint, netMin: bigint, netMax: bigint): FeeRange | null {
    // net = floor(gross * (BPS - fee) / BPS)
    if (gross <= 0n) return null;
    if (netMin < 0n || netMax < 0n) return null;
    if (netMin > netMax) return null;
    if (netMax > gross) netMax = gross;

    const tMin = ceilDiv(netMin * BPS, gross);
    const tMax = floorDiv(((netMax + 1n) * BPS - 1n), gross);
    if (tMin > tMax) return null;

    const feeMin = BPS - tMax;
    const feeMax = BPS - tMin;
    return { min: feeMin, max: feeMax };
}

function invertDxRangeFromDy(
    reserveIn: bigint,
    reserveOut: bigint,
    dy: bigint,
    capDx: bigint
): { min: bigint; max: bigint } | null {
    // dy = floor(reserveOut * dx / (reserveIn + dx))
    // Find the dx range that can produce dy.
    if (dy < 0n) return null;
    if (reserveIn <= 0n || reserveOut <= 0n) return null;
    if (dy >= reserveOut) return null;

    if (dy === 0n) {
        // Any dx that keeps fraction < 1 yields 0 after floor. We cap at capDx.
        return { min: 0n, max: capDx };
    }

    const denomMin = reserveOut - dy;
    if (denomMin <= 0n) return null;
    let min = ceilDiv(reserveIn * dy, denomMin);

    const dy1 = dy + 1n;
    const denomMax = reserveOut - dy1;
    let max = capDx;
    if (denomMax > 0n) {
        // dx < (dy+1)*reserveIn / (reserveOut - (dy+1))
        // For integer dx: dx <= floor(((dy+1)*reserveIn - 1) / (reserveOut - (dy+1)))
        max = floorDiv(dy1 * reserveIn - 1n, denomMax);
        if (max > capDx) max = capDx;
    }

    if (min < 0n) min = 0n;
    if (max < 0n) max = 0n;
    if (min > max) return null;
    return { min, max };
}

function containsFee(r: FeeRange | null, feeBps: bigint): boolean {
    if (!r) return false;
    return feeBps >= r.min && feeBps <= r.max;
}

function feeKey(r: FeeRange | null): string {
    if (!r) return "null";
    return r.min === r.max ? r.min.toString() : `${r.min.toString()}..${r.max.toString()}`;
}

function bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function topK(map: Map<string, number>, k: number): Array<[string, number]> {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}

function parseFeeBpsFromLogs(logs: string[] | undefined): {
    lp?: bigint;
    protocol?: bigint;
    creator?: bigint;
} {
    if (!logs || logs.length === 0) return {};
    const out: { lp?: bigint; protocol?: bigint; creator?: bigint } = {};

    for (const l of logs) {
        // Common variations seen in Anchor logs.
        const mLp = /lpFeeBasisPoints\s*[:=]\s*(\d+)/i.exec(l);
        if (mLp && out.lp === undefined) out.lp = BigInt(mLp[1]);

        const mProt = /protocolFeeBasisPoints\s*[:=]\s*(\d+)/i.exec(l);
        if (mProt && out.protocol === undefined) out.protocol = BigInt(mProt[1]);

        const mCreator = /coinCreatorFeeBasisPoints\s*[:=]\s*(\d+)/i.exec(l);
        if (mCreator && out.creator === undefined) out.creator = BigInt(mCreator[1]);
    }

    return out;
}

// System program default pubkey (null creator check)
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

function isNullCreator(creatorPk: string): boolean {
    return creatorPk === SYSTEM_PROGRAM_ID;
}

function findPumpSwapAccounts(c: CanonicalSwapCase): {
    poolPk: string;
    globalPk: string;
    feeConfigPk: string | null;
} | null {
    const keys = Object.keys(c.preAccounts);

    let poolPk: string | null = null;
    let globalPk: string | null = null;

    for (const k of keys) {
        const a = c.preAccounts[k];
        if (!a || typeof a.dataBase64 !== "string") continue;
        const buf = Buffer.from(a.dataBase64, "base64");
        if (poolPk === null && isPumpSwapPoolAccount(buf)) poolPk = k;
        if (globalPk === null && isPumpSwapGlobalConfigAccount(buf)) globalPk = k;
        if (poolPk !== null && globalPk !== null) break;
    }

    if (poolPk === null || globalPk === null) return null;

    // fee_config PDA is optional in older cases; also keep a fallback scan for discriminator.
    const feeConfigPda = deriveFeeConfigPda(PUMPSWAP_PROGRAM_ID);
    const feeConfigPk = feeConfigPda.toBase58();
    const feeEntry = c.preAccounts[feeConfigPk];
    if (feeEntry && typeof feeEntry.dataBase64 === "string") return { poolPk, globalPk, feeConfigPk };

    for (const k of keys) {
        const a = c.preAccounts[k];
        if (!a || typeof a.dataBase64 !== "string") continue;
        const buf = Buffer.from(a.dataBase64, "base64");
        if (isFeeConfigAccount(buf)) return { poolPk, globalPk, feeConfigPk: k };
    }

    return { poolPk, globalPk, feeConfigPk: null };
}

function decodePool(c: CanonicalSwapCase, poolPk: string): PumpSwapPoolState | null {
    const a = c.preAccounts[poolPk];
    if (!a || typeof a.dataBase64 !== "string") return null;
    const buf = Buffer.from(a.dataBase64, "base64");
    return decodePumpSwapPool(buf);
}

function decodeGlobal(c: CanonicalSwapCase, globalPk: string): PumpSwapGlobalConfig | null {
    const a = c.preAccounts[globalPk];
    if (!a || typeof a.dataBase64 !== "string") return null;
    const buf = Buffer.from(a.dataBase64, "base64");
    return decodePumpSwapGlobalConfig(buf);
}

function decodeFeeCfg(c: CanonicalSwapCase, feeCfgPk: string | null): PumpFeesFeeConfig | null {
    if (!feeCfgPk) return null;
    const a = c.preAccounts[feeCfgPk];
    if (!a || typeof a.dataBase64 !== "string") return null;
    const buf = Buffer.from(a.dataBase64, "base64");
    return decodeFeeConfig(buf);
}

function computeVaultDeltas(
    c: CanonicalSwapCase,
    pool: PumpSwapPoolState
):
    | {
        side: PumpSwapSide;
        baseVaultPk: string;
        quoteVaultPk: string;
        baseRes: bigint;
        quoteRes: bigint;
        baseDelta: bigint;
        quoteDelta: bigint;
        amountIn: bigint;
        actualOut: bigint;
    }
    | null {
    const baseVaultPk = pool.poolBaseTokenAccount.toBase58();
    const quoteVaultPk = pool.poolQuoteTokenAccount.toBase58();

    const bBase = getTokenBalance(c, baseVaultPk);
    const bQuote = getTokenBalance(c, quoteVaultPk);
    if (!bBase || !bQuote) return null;

    const baseRes = BigInt(bBase.preAmount);
    const quoteRes = BigInt(bQuote.preAmount);
    const baseDelta = BigInt(bBase.postAmount) - BigInt(bBase.preAmount);
    const quoteDelta = BigInt(bQuote.postAmount) - BigInt(bQuote.preAmount);

    if (baseDelta > 0n && quoteDelta < 0n) {
        return {
            side: "baseToQuote",
            baseVaultPk,
            quoteVaultPk,
            baseRes,
            quoteRes,
            baseDelta,
            quoteDelta,
            amountIn: baseDelta,
            actualOut: -quoteDelta,
        };
    }

    if (quoteDelta > 0n && baseDelta < 0n) {
        return {
            side: "quoteToBase",
            baseVaultPk,
            quoteVaultPk,
            baseRes,
            quoteRes,
            baseDelta,
            quoteDelta,
            amountIn: quoteDelta,
            actualOut: -baseDelta,
        };
    }

    return null;
}

function cfgFees(cfg: PumpSwapGlobalConfig): {
    lp: bigint;
    protocol: bigint;
    creator: bigint;
    lpPlusProtocol: bigint;
    total: bigint;
} {
    const lp = cfg.lpFeeBasisPoints;
    const protocol = cfg.protocolFeeBasisPoints;
    const creator = cfg.coinCreatorFeeBasisPoints;
    return {
        lp,
        protocol,
        creator,
        lpPlusProtocol: lp + protocol,
        total: lp + protocol + creator,
    };
}

/**
 * Compute the trade fee bps for a given fee config and market cap.
 * Uses tradeFeeBps() which returns lp + protocol (NOT creator).
 */
function getTradeFeeBpsForMarketCap(
    feeCfg: PumpFeesFeeConfig | null,
    marketCapLamports: bigint,
    fallbackFees: PumpFeesFeesBps
): { tradeFee: bigint; source: string; fees: PumpFeesFeesBps } {
    if (!feeCfg || feeCfg.feeTiers.length === 0) {
        return {
            tradeFee: tradeFeeBps(fallbackFees),
            source: "globalConfig",
            fees: fallbackFees,
        };
    }

    // Try lower-bound selection
    const lowerBoundFees = selectTierFeesLowerBound(feeCfg.feeTiers, marketCapLamports);
    if (lowerBoundFees) {
        return {
            tradeFee: tradeFeeBps(lowerBoundFees),
            source: "tier-lowerBound",
            fees: lowerBoundFees,
        };
    }

    // Try upper-bound selection
    const upperBoundFees = selectTierFeesUpperBound(feeCfg.feeTiers, marketCapLamports);
    if (upperBoundFees) {
        return {
            tradeFee: tradeFeeBps(upperBoundFees),
            source: "tier-upperBound",
            fees: upperBoundFees,
        };
    }

    // Fallback to flat fees from fee config
    return {
        tradeFee: tradeFeeBps(feeCfg.flatFees),
        source: "feeConfig-flat",
        fees: feeCfg.flatFees,
    };
}

function printTopHistogram(title: string, map: Map<string, number>, k = 12): void {
    console.log(title);
    for (const [kk, vv] of topK(map, k)) console.log(`  ${vv}  ${kk}`);
    console.log("");
}

async function main(): Promise<void> {
    const file = process.argv[2];
    if (!file) {
        console.error(
            "usage: pnpm exec ts-node src/regression/diagnosePumpSwapModels.ts ./data/canonical_cases.ndjson"
        );
        process.exit(1);
    }

    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

    let total = 0;
    let pumpswap = 0;
    let skippedTxErr = 0;
    let skippedDecode = 0;
    let skippedBalances = 0;
    let used = 0;

    let sellCount = 0;
    let buyCount = 0;

    const sellModelOutputFee = new Map<string, number>();
    const sellModelInputFee = new Map<string, number>();
    const buyModelInputFee = new Map<string, number>();
    const buyModelOutputFee = new Map<string, number>();

    const matchSellOutputFee_total = { hit: 0, miss: 0 };
    const matchSellInputFee_total = { hit: 0, miss: 0 };
    const matchBuyInputFee_total = { hit: 0, miss: 0 };
    const matchBuyOutputFee_total = { hit: 0, miss: 0 };

    const matchSellOutputFee_lpProt = { hit: 0, miss: 0 };
    const matchBuyInputFee_lpProt = { hit: 0, miss: 0 };
    const matchBuyOutputFee_lpProt = { hit: 0, miss: 0 };

    // New: tradeFeeBps model (lp + protocol from tier/config)
    const matchSellOutputFee_tradeFee = { hit: 0, miss: 0 };
    const matchBuyInputFee_tradeFee = { hit: 0, miss: 0 };

    // Tier selection comparison
    const tierLowerBoundHits = { sell: 0, buy: 0 };
    const tierUpperBoundHits = { sell: 0, buy: 0 };

    let feeConfigPresent = 0;
    let feeConfigDecodeOk = 0;

    let logsPresent = 0;
    let logsHaveAllBps = 0;
    let logsDisagreeWithCfg = 0;

    // Creator analysis
    let nullCreatorCount = 0;
    let nonNullCreatorCount = 0;
    const creatorFeeByNullCreator = { null25: 0, null20: 0, nullOther: 0, nonNull25: 0, nonNull20: 0, nonNullOther: 0 };

    // FeeConfig tier analysis
    let feeConfigHasTiers = 0;
    const tierCountHistogram = new Map<number, number>();

    const MAX_PRINT = 30;
    let printedSell = 0;
    let printedBuy = 0;

    for (const line of lines) {
        total++;
        let c: CanonicalSwapCase;
        try {
            c = JSON.parse(line) as CanonicalSwapCase;
        } catch {
            continue;
        }

        if (c.venue !== "pumpswap") continue;
        pumpswap++;

        if (c.tx.err) {
            skippedTxErr++;
            continue;
        }

        const pkInfo = findPumpSwapAccounts(c);
        if (!pkInfo) {
            skippedDecode++;
            continue;
        }

        const pool = decodePool(c, pkInfo.poolPk);
        const globalCfg = decodeGlobal(c, pkInfo.globalPk);
        if (!pool || !globalCfg) {
            skippedDecode++;
            continue;
        }

        const feeCfg = decodeFeeCfg(c, pkInfo.feeConfigPk);
        if (pkInfo.feeConfigPk) feeConfigPresent++;
        if (feeCfg) {
            feeConfigDecodeOk++;
            const tierCount = feeCfg.feeTiers.length;
            tierCountHistogram.set(tierCount, (tierCountHistogram.get(tierCount) ?? 0) + 1);
            if (tierCount > 0) feeConfigHasTiers++;
        }

        const vd = computeVaultDeltas(c, pool);
        if (!vd) {
            skippedBalances++;
            continue;
        }
        used++;

        const cfg = cfgFees(globalCfg);

        // Creator analysis
        const creatorPk = pool.creator.toBase58();
        const creatorIsNull = isNullCreator(creatorPk);
        if (creatorIsNull) nullCreatorCount++;
        else nonNullCreatorCount++;

        // Estimate market cap from quote reserve (rough proxy)
        // In reality, we'd need price oracle, but quote reserve gives us a tier selection proxy
        const estimatedMarketCapLamports = vd.quoteRes * 2n; // Rough estimate: 2x quote reserve

        // Get trade fee using tier selection
        const globalFees: PumpFeesFeesBps = {
            lpFeeBps: cfg.lp,
            protocolFeeBps: cfg.protocol,
            coinCreatorFeeBps: cfg.creator,
        };
        const tradeFeeInfo = getTradeFeeBpsForMarketCap(feeCfg, estimatedMarketCapLamports, globalFees);

        // Also test both tier selection methods explicitly
        let lowerBoundTradeFee: bigint | null = null;
        let upperBoundTradeFee: bigint | null = null;
        if (feeCfg && feeCfg.feeTiers.length > 0) {
            const lbFees = selectTierFeesLowerBound(feeCfg.feeTiers, estimatedMarketCapLamports);
            const ubFees = selectTierFeesUpperBound(feeCfg.feeTiers, estimatedMarketCapLamports);
            if (lbFees) lowerBoundTradeFee = tradeFeeBps(lbFees);
            if (ubFees) upperBoundTradeFee = tradeFeeBps(ubFees);
        }

        if (c.tx.logMessages && c.tx.logMessages.length > 0) {
            logsPresent++;
            const fromLogs = parseFeeBpsFromLogs(c.tx.logMessages);
            if (fromLogs.lp !== undefined && fromLogs.protocol !== undefined && fromLogs.creator !== undefined) {
                logsHaveAllBps++;
                if (
                    fromLogs.lp !== cfg.lp ||
                    fromLogs.protocol !== cfg.protocol ||
                    fromLogs.creator !== cfg.creator
                ) {
                    logsDisagreeWithCfg++;
                }
            }
        }

        if (vd.side === "baseToQuote") {
            sellCount++;
            const grossOut = cpOut(vd.baseRes, vd.quoteRes, vd.amountIn);

            // Model S1: fee on OUTPUT
            const rOutFee = feeRangeFromGrossAndActual(grossOut, vd.actualOut);
            bump(sellModelOutputFee, feeKey(rOutFee));

            // Model S2: fee on INPUT
            const netRange = invertDxRangeFromDy(vd.baseRes, vd.quoteRes, vd.actualOut, vd.amountIn);
            const rInFee = netRange ? feeRangeFromGrossAndNetRange(vd.amountIn, netRange.min, netRange.max) : null;
            bump(sellModelInputFee, feeKey(rInFee));

            if (containsFee(rOutFee, cfg.total)) matchSellOutputFee_total.hit++;
            else matchSellOutputFee_total.miss++;

            if (containsFee(rInFee, cfg.total)) matchSellInputFee_total.hit++;
            else matchSellInputFee_total.miss++;

            if (containsFee(rOutFee, cfg.lpPlusProtocol)) matchSellOutputFee_lpProt.hit++;
            else matchSellOutputFee_lpProt.miss++;

            // New: tradeFeeBps model
            if (containsFee(rOutFee, tradeFeeInfo.tradeFee)) matchSellOutputFee_tradeFee.hit++;
            else matchSellOutputFee_tradeFee.miss++;

            // Tier selection comparison
            if (lowerBoundTradeFee !== null && containsFee(rOutFee, lowerBoundTradeFee)) tierLowerBoundHits.sell++;
            if (upperBoundTradeFee !== null && containsFee(rOutFee, upperBoundTradeFee)) tierUpperBoundHits.sell++;

            // Track creator correlation with fee range
            const feeRangeVal = rOutFee ? rOutFee.min : -1n;
            if (creatorIsNull) {
                if (feeRangeVal === 25n) creatorFeeByNullCreator.null25++;
                else if (feeRangeVal === 20n) creatorFeeByNullCreator.null20++;
                else creatorFeeByNullCreator.nullOther++;
            } else {
                if (feeRangeVal === 25n) creatorFeeByNullCreator.nonNull25++;
                else if (feeRangeVal === 20n) creatorFeeByNullCreator.nonNull20++;
                else creatorFeeByNullCreator.nonNullOther++;
            }

            // Debug output for mismatches
            if (printedSell < MAX_PRINT && !containsFee(rOutFee, tradeFeeInfo.tradeFee)) {
                printedSell++;
                console.log(
                    `MISS sell(output-fee) sig=${c.signature.slice(0, 32)}... slot=${c.slot} ` +
                    `grossOut=${grossOut} actualOut=${vd.actualOut} ` +
                    `feeRange=${feeKey(rOutFee)} tradeFee=${tradeFeeInfo.tradeFee} source=${tradeFeeInfo.source} ` +
                    `cfgTotal=${cfg.total} cfgLpProt=${cfg.lpPlusProtocol}`
                );
                console.log(
                    `  pool.creator=${creatorPk.slice(0, 16)}... isNull=${creatorIsNull}`
                );
                console.log(
                    `  estimatedMarketCap=${estimatedMarketCapLamports} (${Number(estimatedMarketCapLamports) / 1e9} SOL)`
                );
                if (feeCfg) {
                    console.log(
                        `  feeConfig.flat=[lp=${feeCfg.flatFees.lpFeeBps} prot=${feeCfg.flatFees.protocolFeeBps} creator=${feeCfg.flatFees.coinCreatorFeeBps}] tiers=${feeCfg.feeTiers.length}`
                    );
                    if (feeCfg.feeTiers.length > 0) {
                        for (const t of feeCfg.feeTiers.slice(0, 5)) {
                            console.log(
                                `    tier: cap>=${t.marketCapLamportsThreshold} lp=${t.fees.lpFeeBps} prot=${t.fees.protocolFeeBps} creator=${t.fees.coinCreatorFeeBps} extra=${t.extraU64}`
                            );
                        }
                    }
                }
            }
        } else {
            buyCount++;
            const grossOut = cpOut(vd.quoteRes, vd.baseRes, vd.amountIn);

            // Model B1: fee on INPUT (quote)
            const netRange = invertDxRangeFromDy(vd.quoteRes, vd.baseRes, vd.actualOut, vd.amountIn);
            const rInFee = netRange ? feeRangeFromGrossAndNetRange(vd.amountIn, netRange.min, netRange.max) : null;
            bump(buyModelInputFee, feeKey(rInFee));

            // Model B2: fee on OUTPUT (base)
            const rOutFee = feeRangeFromGrossAndActual(grossOut, vd.actualOut);
            bump(buyModelOutputFee, feeKey(rOutFee));

            if (containsFee(rInFee, cfg.total)) matchBuyInputFee_total.hit++;
            else matchBuyInputFee_total.miss++;

            if (containsFee(rOutFee, cfg.total)) matchBuyOutputFee_total.hit++;
            else matchBuyOutputFee_total.miss++;

            if (containsFee(rInFee, cfg.lpPlusProtocol)) matchBuyInputFee_lpProt.hit++;
            else matchBuyInputFee_lpProt.miss++;

            if (containsFee(rOutFee, cfg.lpPlusProtocol)) matchBuyOutputFee_lpProt.hit++;
            else matchBuyOutputFee_lpProt.miss++;

            // New: tradeFeeBps model (input fee for BUY)
            if (containsFee(rInFee, tradeFeeInfo.tradeFee)) matchBuyInputFee_tradeFee.hit++;
            else matchBuyInputFee_tradeFee.miss++;

            // Tier selection comparison
            if (lowerBoundTradeFee !== null && containsFee(rInFee, lowerBoundTradeFee)) tierLowerBoundHits.buy++;
            if (upperBoundTradeFee !== null && containsFee(rInFee, upperBoundTradeFee)) tierUpperBoundHits.buy++;

            // Debug output for mismatches (now checking both models)
            const matchesAnyLpProt = containsFee(rInFee, cfg.lpPlusProtocol) || containsFee(rOutFee, cfg.lpPlusProtocol);
            const matchesTradeFee = containsFee(rInFee, tradeFeeInfo.tradeFee);
            if (printedBuy < MAX_PRINT && !matchesAnyLpProt && !matchesTradeFee) {
                printedBuy++;
                console.log(
                    `MISS buy sig=${c.signature.slice(0, 32)}... slot=${c.slot} ` +
                    `grossIn=${vd.amountIn} actualOut=${vd.actualOut} grossOut=${grossOut} ` +
                    `feeRange(in)=${feeKey(rInFee)} feeRange(out)=${feeKey(rOutFee)} ` +
                    `tradeFee=${tradeFeeInfo.tradeFee} source=${tradeFeeInfo.source} ` +
                    `cfgTotal=${cfg.total} cfgLpProt=${cfg.lpPlusProtocol}`
                );
                console.log(
                    `  pool.creator=${creatorPk.slice(0, 16)}... isNull=${creatorIsNull}`
                );
                console.log(
                    `  reserves: base=${vd.baseRes} quote=${vd.quoteRes}`
                );
                console.log(
                    `  estimatedMarketCap=${estimatedMarketCapLamports} (${Number(estimatedMarketCapLamports) / 1e9} SOL)`
                );
                if (feeCfg) {
                    console.log(
                        `  feeConfig.flat=[lp=${feeCfg.flatFees.lpFeeBps} prot=${feeCfg.flatFees.protocolFeeBps} creator=${feeCfg.flatFees.coinCreatorFeeBps}] tiers=${feeCfg.feeTiers.length}`
                    );
                    if (feeCfg.feeTiers.length > 0) {
                        for (const t of feeCfg.feeTiers.slice(0, 5)) {
                            console.log(
                                `    tier: cap>=${t.marketCapLamportsThreshold} lp=${t.fees.lpFeeBps} prot=${t.fees.protocolFeeBps} creator=${t.fees.coinCreatorFeeBps} extra=${t.extraU64}`
                            );
                        }
                    }
                }
            }
        }
    }

    console.log("");
    console.log("=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total lines: ${total}`);
    console.log(`PumpSwap cases: ${pumpswap}`);
    console.log(`Skipped tx.err: ${skippedTxErr}`);
    console.log(`Skipped decode: ${skippedDecode}`);
    console.log(`Skipped balances: ${skippedBalances}`);
    console.log(`Used: ${used}`);
    console.log(`Inferred sells: ${sellCount}`);
    console.log(`Inferred buys: ${buyCount}`);
    console.log("");

    console.log("=".repeat(60));
    console.log("FEE CONFIG ANALYSIS");
    console.log("=".repeat(60));
    console.log(`FeeConfig present: ${feeConfigPresent}`);
    console.log(`FeeConfig decoded: ${feeConfigDecodeOk}`);
    console.log(`FeeConfig with tiers: ${feeConfigHasTiers}`);
    console.log("Tier count histogram:");
    for (const [count, freq] of [...tierCountHistogram.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`  ${count} tiers: ${freq} cases`);
    }
    console.log("");

    console.log("=".repeat(60));
    console.log("TIER SELECTION COMPARISON");
    console.log("=".repeat(60));
    console.log(`Lower-bound tier selection hits: SELL=${tierLowerBoundHits.sell} BUY=${tierLowerBoundHits.buy}`);
    console.log(`Upper-bound tier selection hits: SELL=${tierUpperBoundHits.sell} BUY=${tierUpperBoundHits.buy}`);
    console.log("");

    console.log("=".repeat(60));
    console.log("CREATOR ANALYSIS");
    console.log("=".repeat(60));
    console.log(`Null creator pools: ${nullCreatorCount}`);
    console.log(`Non-null creator pools: ${nonNullCreatorCount}`);
    console.log("Fee range by creator status (SELL output-fee model):");
    console.log(`  null creator, 25 bps: ${creatorFeeByNullCreator.null25}`);
    console.log(`  null creator, 20 bps: ${creatorFeeByNullCreator.null20}`);
    console.log(`  null creator, other:  ${creatorFeeByNullCreator.nullOther}`);
    console.log(`  non-null creator, 25 bps: ${creatorFeeByNullCreator.nonNull25}`);
    console.log(`  non-null creator, 20 bps: ${creatorFeeByNullCreator.nonNull20}`);
    console.log(`  non-null creator, other:  ${creatorFeeByNullCreator.nonNullOther}`);
    console.log("");

    console.log("=".repeat(60));
    console.log("LOG ANALYSIS");
    console.log("=".repeat(60));
    console.log(`Logs present: ${logsPresent}`);
    console.log(`Logs have lp/protocol/creator: ${logsHaveAllBps}`);
    console.log(`Logs disagree with decoded global_config bps: ${logsDisagreeWithCfg}`);
    console.log("");

    console.log("=".repeat(60));
    console.log("MODEL FIT: cfgTotal (lp + protocol + creator = 30 bps)");
    console.log("=".repeat(60));
    console.log(
        `SELL model (fee on OUTPUT) hits: ${matchSellOutputFee_total.hit} misses: ${matchSellOutputFee_total.miss}`
    );
    console.log(
        `SELL model (fee on INPUT)  hits: ${matchSellInputFee_total.hit} misses: ${matchSellInputFee_total.miss}`
    );
    console.log(
        `BUY model  (fee on INPUT)  hits: ${matchBuyInputFee_total.hit} misses: ${matchBuyInputFee_total.miss}`
    );
    console.log(
        `BUY model  (fee on OUTPUT) hits: ${matchBuyOutputFee_total.hit} misses: ${matchBuyOutputFee_total.miss}`
    );
    console.log("");

    console.log("=".repeat(60));
    console.log("MODEL FIT: cfgLp+Prot (lp + protocol = 25 bps)");
    console.log("=".repeat(60));
    console.log(
        `SELL model (fee on OUTPUT) hits: ${matchSellOutputFee_lpProt.hit} misses: ${matchSellOutputFee_lpProt.miss}`
    );
    console.log(
        `BUY model  (fee on INPUT)  hits: ${matchBuyInputFee_lpProt.hit} misses: ${matchBuyInputFee_lpProt.miss}`
    );
    console.log(
        `BUY model  (fee on OUTPUT) hits: ${matchBuyOutputFee_lpProt.hit} misses: ${matchBuyOutputFee_lpProt.miss}`
    );
    console.log("");

    console.log("=".repeat(60));
    console.log("MODEL FIT: tradeFeeBps (from tier/config selection)");
    console.log("=".repeat(60));
    console.log(
        `SELL model (fee on OUTPUT) hits: ${matchSellOutputFee_tradeFee.hit} misses: ${matchSellOutputFee_tradeFee.miss}`
    );
    console.log(
        `BUY model  (fee on INPUT)  hits: ${matchBuyInputFee_tradeFee.hit} misses: ${matchBuyInputFee_tradeFee.miss}`
    );
    console.log("");

    console.log("=".repeat(60));
    console.log("IMPLIED FEE HISTOGRAMS");
    console.log("=".repeat(60));
    printTopHistogram("Top implied fee ranges (SELL, fee on OUTPUT):", sellModelOutputFee);
    printTopHistogram("Top implied fee ranges (SELL, fee on INPUT):", sellModelInputFee);
    printTopHistogram("Top implied fee ranges (BUY, fee on INPUT):", buyModelInputFee);
    printTopHistogram("Top implied fee ranges (BUY, fee on OUTPUT):", buyModelOutputFee);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});