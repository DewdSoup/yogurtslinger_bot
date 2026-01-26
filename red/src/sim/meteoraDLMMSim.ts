// src/sim/meteoraDLMMSim.ts
//
// Integer-only Meteora DLMM (Liquidity Book) swap simulator.
// - Pure BigInt (no Number(bigint))
// - Q64.64 price representation
// - Bin traversal across a pre-decoded bin liquidity map
//
// NOTE ON FEE MATH:
// This implementation keeps your /1e17 scaling for total fee:
//   baseFee  = baseFactor * binStep / 1e8   (lifted into /1e17 domain)
//   varFee   = varControl * (volAcc * binStep)^2 / 1e17
//   totalFee = clamp(baseFee + varFee, 0, 0.10)
// If regression against swap_decode shows systematic deltas, we can
// tune computeMeteoraFeeNumerator without touching the swap core.

import type { MeteoraLbPairState } from "../decoders/meteoraLbPair";
import type { MeteoraBinLiquidity } from "../decoders/meteoraBinArray";

/**
 * Q64.64 fixed-point scale.
 */
const Q64 = 1n << 64n;

/**
 * Fee denominator for DLMM variable fee math.
 * Your formula uses / 1e17, so we keep that exact.
 */
const FEE_DENOM = 100_000_000_000_000_000n; // 1e17
const BASE_FEE_MULT = 1_000_000_000n; // 1e9 to lift base fee (/1e8) into /1e17 domain
const PROTOCOL_SHARE_DENOM = 10_000n; // bps

export type MeteoraSwapDirection = "xToY" | "yToX";
export type MeteoraFeeMode = "output" | "input";

export type MeteoraSimParams = {
    lbPair: MeteoraLbPairState;

    /**
     * Bin liquidity by binId (i32 range).
     * Typically built from several BinArray accounts around activeId.
     */
    bins: Map<number, MeteoraBinLiquidity>;

    direction: MeteoraSwapDirection;
    amountIn: bigint;

    /**
     * How to charge fee.
     * - "output": compute fee on output of each bin segment.
     * - "input": compute fee on input consumed per bin segment.
     *
     * Default: "output" because it avoids having to invert net/gross when bins cap output.
     */
    feeMode?: MeteoraFeeMode;

    /**
     * Safety guard: max bins to traverse to avoid pathological loops if dependencies are missing.
     */
    maxTraverseBins?: number;

    /**
     * If true, returns per-bin diagnostics (more allocations).
     */
    collectSteps?: boolean;
};

export type MeteoraSimStep = {
    binId: number;
    priceQ64: bigint;

    inConsumed: bigint;

    outBeforeFee: bigint;
    feeAmount: bigint;
    outToUser: bigint;

    binBefore: MeteoraBinLiquidity;
    binAfter: MeteoraBinLiquidity;
};

export type MeteoraSimResult = {
    amountIn: bigint;
    amountOut: bigint;

    feeMode: MeteoraFeeMode;

    /**
     * Fee total in the token the fee is charged in:
     * - feeMode="output": fee is in output token (Y for xToY, X for yToX)
     * - feeMode="input": fee is in input token (X for xToY, Y for yToX)
     */
    feeTotal: bigint;
    protocolFee: bigint;
    lpFee: bigint;

    startBinId: number;
    endBinId: number;

    steps?: MeteoraSimStep[];
};

function minBig(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
}

function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
    if (d === 0n) throw new Error("mulDivFloor division by zero");
    return (a * b) / d;
}

function clamp(n: bigint, lo: bigint, hi: bigint): bigint {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

/**
 * Compute total fee numerator with denominator = 1e17.
 *
 * Matches your integer-only objective for:
 *   baseFee = baseFactor * binStep / 1e8
 *   varFee  = varControl * (volAcc * binStep)^2 / 1e17
 *
 * Convert baseFee to /1e17 by multiplying numerator by 1e9.
 */
export function computeMeteoraFeeNumerator(lb: MeteoraLbPairState): bigint {
    const baseFactor = BigInt(lb.baseFactor);
    const binStep = BigInt(lb.binStep);
    const varControl = BigInt(lb.variableFeeControl);
    const volAcc = BigInt(lb.volatilityAccumulator);

    // baseNumer / 1e17
    const baseNumer = baseFactor * binStep * BASE_FEE_MULT; // (baseFactor*binStep*1e9)/1e17 == /1e8

    // varNumer / 1e17
    const vBs = volAcc * binStep;
    const varNumer = varControl * vBs * vBs;

    // Cap at 10% (0.10 = 1e16 / 1e17)
    const capNumer = 10_000_000_000_000_000n; // 1e16
    return clamp(baseNumer + varNumer, 0n, capNumer);
}

/**
 * Convert binStep (bps) into a Q64.64 multiplier: (10000+binStep)/10000 in Q64.64.
 */
function basisQ64(binStep: number): bigint {
    const num = BigInt(10_000 + binStep);
    return (num * Q64) / 10_000n; // floor
}

/**
 * pow for Q64.64 base, returns Q64.64 result.
 * exponent must be >= 0.
 */
function powQ64(baseQ: bigint, exp: number): bigint {
    let e = exp;
    let result = Q64; // 1.0 in Q64.64
    let b = baseQ;

    while (e > 0) {
        if (e & 1) {
            result = (result * b) >> 64n; // /Q64
        }
        e >>= 1;
        if (e > 0) {
            b = (b * b) >> 64n; // /Q64
        }
    }
    return result;
}

/**
 * Price for a binId in Q64.64.
 * This is lamportsY per lamportsX in Q64.64 (consistent with your earlier notes).
 */
export function priceQ64FromBinId(binId: number, binStep: number): bigint {
    const baseQ = basisQ64(binStep);
    if (binId === 0) return Q64;

    const abs = Math.abs(binId);
    const p = powQ64(baseQ, abs);

    if (binId > 0) return p;

    // inverse in Q64.64: Q64^2 / p
    return (Q64 * Q64) / p;
}

class PriceCursor {
    readonly baseQ: bigint;
    binId: number;
    priceQ: bigint;

    constructor(binId: number, binStep: number) {
        this.baseQ = basisQ64(binStep);
        this.binId = binId;
        this.priceQ = priceQ64FromBinId(binId, binStep);
    }

    /** Move to next higher bin (binId + 1). */
    up(): void {
        this.binId += 1;
        this.priceQ = (this.priceQ * this.baseQ) >> 64n;
    }

    /** Move to next lower bin (binId - 1). */
    down(): void {
        this.binId -= 1;
        // priceQ = priceQ / base
        this.priceQ = (this.priceQ << 64n) / this.baseQ;
    }
}

/**
 * Max input in X such that floor(inX * priceQ / Q64) <= yLiquidity.
 * i.e. outputBeforeFee in Y cannot exceed available Y.
 */
function maxInXGivenYLiquidity(y: bigint, priceQ: bigint): bigint {
    if (y <= 0n) return 0n;
    // floor( ((y+1)*Q64 - 1) / priceQ )
    return (((y + 1n) << 64n) - 1n) / priceQ;
}

/**
 * Max input in Y such that floor(inY * Q64 / priceQ) <= xLiquidity.
 * i.e. outputBeforeFee in X cannot exceed available X.
 */
function maxInYGivenXLiquidity(x: bigint, priceQ: bigint): bigint {
    if (x <= 0n) return 0n;
    // floor( ((x+1)*priceQ - 1) / Q64 ) == ((x+1)*priceQ -1) >> 64
    return (((x + 1n) * priceQ) - 1n) >> 64n;
}

/**
 * Simulate a Meteora DLMM swap via bin traversal.
 * Deterministic BigInt math. No Number() conversions in the hot path.
 */
export function simulateMeteoraDlmmSwap(p: MeteoraSimParams): MeteoraSimResult {
    const feeMode: MeteoraFeeMode = p.feeMode ?? "output";
    const maxTraverseBins = p.maxTraverseBins ?? 512;

    if (p.amountIn <= 0n) {
        return {
            amountIn: p.amountIn,
            amountOut: 0n,
            feeMode,
            feeTotal: 0n,
            protocolFee: 0n,
            lpFee: 0n,
            startBinId: p.lbPair.activeId,
            endBinId: p.lbPair.activeId,
            ...(p.collectSteps ? { steps: [] } : {}),
        };
    }

    const lb = p.lbPair;
    const feeNumer = computeMeteoraFeeNumerator(lb);
    const feeDenom = FEE_DENOM;

    let remainingIn = p.amountIn;
    let totalOut = 0n;
    let totalFee = 0n;

    const cursor = new PriceCursor(lb.activeId, lb.binStep);

    const steps: MeteoraSimStep[] | undefined = p.collectSteps ? [] : undefined;

    const startBinId = cursor.binId;

    let traversed = 0;
    while (remainingIn > 0n && traversed < maxTraverseBins) {
        const binId = cursor.binId;
        const priceQ = cursor.priceQ;

        const bin0 = p.bins.get(binId);
        const binBefore: MeteoraBinLiquidity = bin0
            ? { amountX: bin0.amountX, amountY: bin0.amountY }
            : { amountX: 0n, amountY: 0n };

        // Output-side liquidity for this direction
        const outLiq =
            p.direction === "xToY" ? binBefore.amountY : binBefore.amountX;

        // If no output liquidity, move to next bin and continue
        if (outLiq === 0n) {
            if (p.direction === "xToY") cursor.up();
            else cursor.down();
            traversed++;
            continue;
        }

        // Max *gross* input we can consume in this bin without exceeding output liquidity
        let maxInThisBin: bigint;
        if (p.direction === "xToY") {
            maxInThisBin = maxInXGivenYLiquidity(binBefore.amountY, priceQ);
        } else {
            maxInThisBin = maxInYGivenXLiquidity(binBefore.amountX, priceQ);
        }

        if (maxInThisBin <= 0n) {
            // Price too extreme relative to liquidity; skip to next bin
            if (p.direction === "xToY") cursor.up();
            else cursor.down();
            traversed++;
            continue;
        }

        const inConsumed = minBig(remainingIn, maxInThisBin);

        // Compute outBeforeFee and fee based on selected fee mode
        let outBeforeFee: bigint;
        let feeAmount: bigint;
        let outToUser: bigint;
        let netInForReserves: bigint;

        if (feeMode === "input") {
            // Fee charged on input segment
            const feeIn = mulDivFloor(inConsumed, feeNumer, feeDenom);
            netInForReserves = inConsumed - feeIn;

            if (p.direction === "xToY") {
                outBeforeFee = (netInForReserves * priceQ) >> 64n;
            } else {
                outBeforeFee = (netInForReserves << 64n) / priceQ;
            }

            feeAmount = feeIn;
            outToUser = outBeforeFee;
        } else {
            // Fee charged on output segment
            netInForReserves = inConsumed;

            if (p.direction === "xToY") {
                outBeforeFee = (inConsumed * priceQ) >> 64n;
            } else {
                outBeforeFee = (inConsumed << 64n) / priceQ;
            }

            feeAmount = mulDivFloor(outBeforeFee, feeNumer, feeDenom);
            outToUser = outBeforeFee - feeAmount;
        }

        // Apply bin mutations using:
        // - netInForReserves (what the pool actually keeps on the input side)
        // - outBeforeFee     (what leaves the pool on the output side, incl. fee if feeMode="output")
        let binAfter: MeteoraBinLiquidity;

        if (p.direction === "xToY") {
            const newX = binBefore.amountX + netInForReserves;
            const newY = binBefore.amountY - outBeforeFee;
            if (newX < 0n || newY < 0n) {
                throw new Error(
                    `Meteora bin underflow (xToY): bin=${binId} newX=${newX} newY=${newY}`
                );
            }
            binAfter = { amountX: newX, amountY: newY };
        } else {
            const newY = binBefore.amountY + netInForReserves;
            const newX = binBefore.amountX - outBeforeFee;
            if (newX < 0n || newY < 0n) {
                throw new Error(
                    `Meteora bin underflow (yToX): bin=${binId} newX=${newX} newY=${newY}`
                );
            }
            binAfter = { amountX: newX, amountY: newY };
        }

        p.bins.set(binId, binAfter);

        // Totals
        remainingIn -= inConsumed;
        totalOut += outToUser;
        totalFee += feeAmount;

        if (steps) {
            steps.push({
                binId,
                priceQ64: priceQ,
                inConsumed,
                outBeforeFee,
                feeAmount,
                outToUser,
                binBefore,
                binAfter,
            });
        }

        // Done?
        if (remainingIn <= 0n) break;

        // Move to next bin in the swap direction
        if (p.direction === "xToY") cursor.up();
        else cursor.down();

        traversed++;
    }

    const protocolFee = mulDivFloor(
        totalFee,
        BigInt(lb.protocolShare),
        PROTOCOL_SHARE_DENOM
    );
    const lpFee = totalFee - protocolFee;

    return {
        amountIn: p.amountIn,
        amountOut: totalOut,
        feeMode,
        feeTotal: totalFee,
        protocolFee,
        lpFee,
        startBinId,
        endBinId: cursor.binId,
        ...(steps ? { steps } : {}),
    };
}
