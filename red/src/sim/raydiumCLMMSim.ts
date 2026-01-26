// src/sim/raydiumCLMMSim.ts
//
// Pure-BigInt Raydium CLMM exact-input swap simulator with tick traversal.
// - No Number(bigint)
// - Uses Q64.64 sqrtPriceX64 arithmetic
// - Tick traversal across initialized ticks (from decoded TickArrays)
//
// Notes:
// - Structured like Uniswap V3 / Whirlpool swap math.
// - tradeFeeRate denominator is 1_000_000 (Raydium AmmConfig).

import type { RaydiumCLMMPoolState } from "../decoders/raydiumCLMMPool";
import type { RaydiumAmmConfigState } from "../decoders/raydiumAmmConfig";
import type { RaydiumTickArrayState } from "../decoders/raydiumTickArray";

export const Q64 = 1n << 64n;
const Q128 = 1n << 128n;
const Q256 = 1n << 256n;
const MAX_U256 = Q256 - 1n;

export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

// Raydium uses fee denom 1_000_000 in AmmConfig tradeFeeRate
export const FEE_DENOM = 1_000_000n;

export interface CLMMSwapResult {
    amountIn: bigint;       // gross specified input
    amountOut: bigint;      // output received
    feeAmount: bigint;      // fee taken from input (exact input swaps)
    sqrtPriceAfterX64: bigint;
    tickAfter: number;
    liquidityAfter: bigint;
    ticksCrossed: number;
}

type InitTick = {
    tick: number;
    liquidityNet: bigint; // i128
};

/** Floor(a*b/d) */
function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
    if (d === 0n) throw new Error("mulDivFloor div by zero");
    return (a * b) / d;
}

/** Ceil(a*b/d) */
function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
    if (d === 0n) throw new Error("mulDivRoundingUp div by zero");
    const p = a * b;
    const q = p / d;
    const r = p % d;
    return r === 0n ? q : q + 1n;
}

/** Ceil(n/d) */
function divRoundingUp(n: bigint, d: bigint): bigint {
    if (d === 0n) throw new Error("divRoundingUp div by zero");
    const q = n / d;
    const r = n % d;
    return r === 0n ? q : q + 1n;
}

/**
 * TickMath: sqrtPriceX64 at tick
 * - ratio starts at 2^128
 * - multiply by precomputed constants, shift >> 128
 * - invert for positive tick
 * - convert Q128.128 -> Q64.64 by shifting right 64, rounding up
 */
export function getSqrtPriceX64AtTick(tick: number): bigint {
    if (tick < MIN_TICK || tick > MAX_TICK) {
        throw new Error(`tick out of range: ${tick}`);
    }

    const absTick = tick < 0 ? -tick : tick;

    let ratio = Q128;

    if (absTick & 0x1) ratio = (ratio * 0xfffcb933bd6fad37aa2d162d1a594001n) >> 128n;
    if (absTick & 0x2) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
    if (absTick & 0x4) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
    if (absTick & 0x8) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
    if (absTick & 0x10) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
    if (absTick & 0x20) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
    if (absTick & 0x40) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
    if (absTick & 0x80) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
    if (absTick & 0x100) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
    if (absTick & 0x200) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
    if (absTick & 0x400) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
    if (absTick & 0x800) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
    if (absTick & 0x1000) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
    if (absTick & 0x2000) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
    if (absTick & 0x4000) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
    if (absTick & 0x8000) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
    if (absTick & 0x10000) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
    if (absTick & 0x20000) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
    if (absTick & 0x40000) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
    if (absTick & 0x80000) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

    if (tick > 0) {
        ratio = MAX_U256 / ratio;
    }

    const shifted = ratio >> 64n;
    const rem = ratio & ((1n << 64n) - 1n);
    return rem === 0n ? shifted : shifted + 1n;
}

/**
 * Amount1 delta: Δy = L * (sqrtB - sqrtA) / Q64
 */
function getAmount1Delta(
    sqrtA: bigint,
    sqrtB: bigint,
    liquidity: bigint,
    roundUp: boolean
): bigint {
    if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
    const diff = sqrtB - sqrtA;
    const num = liquidity * diff;
    return roundUp ? divRoundingUp(num, Q64) : num / Q64;
}

/**
 * Amount0 delta: Δx = L * (sqrtB - sqrtA) * Q64 / (sqrtB * sqrtA)
 */
function getAmount0Delta(
    sqrtA: bigint,
    sqrtB: bigint,
    liquidity: bigint,
    roundUp: boolean
): bigint {
    if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
    const diff = sqrtB - sqrtA;
    const num = liquidity * diff * Q64;
    const den = sqrtB * sqrtA;
    return roundUp ? divRoundingUp(num, den) : num / den;
}

/**
 * Next sqrt price from exact input.
 * - zeroForOne (token0 in): sqrtP_next = ceil((L<<64)*sqrtP / ((L<<64) + amountIn*sqrtP))
 * - oneForZero (token1 in): sqrtP_next = sqrtP + floor((amountIn<<64)/L)
 */
function getNextSqrtPriceFromInput(
    sqrtPX64: bigint,
    liquidity: bigint,
    amountIn: bigint,
    zeroForOne: boolean
): bigint {
    if (amountIn === 0n) return sqrtPX64;
    if (liquidity === 0n) throw new Error("liquidity=0");

    if (zeroForOne) {
        const liquidityX64 = liquidity << 64n;
        const denom = liquidityX64 + amountIn * sqrtPX64;
        return mulDivRoundingUp(liquidityX64, sqrtPX64, denom);
    } else {
        const delta = (amountIn << 64n) / liquidity; // floor
        return sqrtPX64 + delta;
    }
}

type SwapStep = {
    sqrtPriceNextX64: bigint;
    amountIn: bigint;   // net input (excluding fee)
    amountOut: bigint;
    feeAmount: bigint;  // input fee amount for the step
};

function computeSwapStepExactIn(
    sqrtPriceCurrentX64: bigint,
    sqrtPriceTargetX64: bigint,
    liquidity: bigint,
    amountRemaining: bigint, // gross remaining
    feeRate: bigint,         // per FEE_DENOM
    zeroForOne: boolean
): SwapStep {
    if (amountRemaining <= 0n) {
        return {
            sqrtPriceNextX64: sqrtPriceCurrentX64,
            amountIn: 0n,
            amountOut: 0n,
            feeAmount: 0n,
        };
    }
    if (liquidity === 0n) {
        return {
            sqrtPriceNextX64: sqrtPriceCurrentX64,
            amountIn: 0n,
            amountOut: 0n,
            feeAmount: 0n,
        };
    }

    const feeComplement = FEE_DENOM - feeRate;
    if (feeRate < 0n || feeRate > FEE_DENOM) throw new Error(`feeRate out of range: ${feeRate}`);

    const amountRemainingLessFee = mulDivFloor(amountRemaining, feeComplement, FEE_DENOM);

    let amountInToTarget: bigint;
    let amountOutToTarget: bigint;

    if (zeroForOne) {
        amountInToTarget = getAmount0Delta(sqrtPriceTargetX64, sqrtPriceCurrentX64, liquidity, true);
        amountOutToTarget = getAmount1Delta(sqrtPriceTargetX64, sqrtPriceCurrentX64, liquidity, false);
    } else {
        amountInToTarget = getAmount1Delta(sqrtPriceCurrentX64, sqrtPriceTargetX64, liquidity, true);
        amountOutToTarget = getAmount0Delta(sqrtPriceCurrentX64, sqrtPriceTargetX64, liquidity, false);
    }

    if (amountRemainingLessFee >= amountInToTarget) {
        const sqrtPriceNextX64 = sqrtPriceTargetX64;
        const amountIn = amountInToTarget;
        const amountOut = amountOutToTarget;

        const feeAmount =
            feeRate === 0n ? 0n : mulDivRoundingUp(amountIn, feeRate, feeComplement);

        return { sqrtPriceNextX64, amountIn, amountOut, feeAmount };
    } else {
        const sqrtPriceNextX64 = getNextSqrtPriceFromInput(
            sqrtPriceCurrentX64,
            liquidity,
            amountRemainingLessFee,
            zeroForOne
        );

        const amountIn = amountRemainingLessFee;
        const amountOut = zeroForOne
            ? getAmount1Delta(sqrtPriceNextX64, sqrtPriceCurrentX64, liquidity, false)
            : getAmount0Delta(sqrtPriceCurrentX64, sqrtPriceNextX64, liquidity, false);

        const feeAmount = amountRemaining - amountIn;

        return { sqrtPriceNextX64, amountIn, amountOut, feeAmount };
    }
}

/**
 * Build a de-duplicated list of initialized ticks from the given TickArrays.
 * This pre-aggregation is what you will eventually cache in PoolRegistry.
 */
function buildInitializedTickList(tickArrays: RaydiumTickArrayState[]): InitTick[] {
    const byTick = new Map<number, bigint>();

    for (const ta of tickArrays) {
        for (const t of ta.ticks) {
            if (!t.initialized) continue;

            const tickIndex = t.tick; // uses alias we added in decoder
            const prev = byTick.get(tickIndex);

            // Instead of throwing on mismatch, aggregate liquidityNet contributions.
            if (prev !== undefined) {
                byTick.set(tickIndex, prev + t.liquidityNet);
            } else {
                byTick.set(tickIndex, t.liquidityNet);
            }
        }
    }

    const out: InitTick[] = Array.from(byTick.entries()).map(([tick, liquidityNet]) => ({
        tick,
        liquidityNet,
    }));

    out.sort((a, b) => a.tick - b.tick);
    return out;
}

function lowerBoundTicks(arr: InitTick[], tick: number): number {
    // first index i where arr[i].tick >= tick
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid]!.tick < tick) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function nextInitializedTick(
    ticks: InitTick[],
    currentTick: number,
    zeroForOne: boolean
): InitTick | null {
    if (ticks.length === 0) return null;

    if (zeroForOne) {
        // greatest initialized tick <= currentTick
        const idx = lowerBoundTicks(ticks, currentTick + 1);
        const j = idx - 1;
        return j >= 0 ? ticks[j]! : null;
    } else {
        // smallest initialized tick > currentTick
        const idx = lowerBoundTicks(ticks, currentTick + 1);
        return idx < ticks.length ? ticks[idx]! : null;
    }
}

/**
 * Compute tick from sqrtPrice via binary search (deterministic, pure integer).
 * Returns greatest tick such that sqrtPriceAtTick(tick) <= sqrtPrice.
 */
export function getTickAtSqrtPriceX64(sqrtPriceX64: bigint): number {
    let lo = MIN_TICK;
    let hi = MAX_TICK;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const s = getSqrtPriceX64AtTick(mid);
        if (s <= sqrtPriceX64) lo = mid + 1;
        else hi = mid - 1;
    }
    return hi;
}

/**
 * Main entry: exact-input swap sim.
 * - zeroForOne = true  => token0 in, token1 out
 * - zeroForOne = false => token1 in, token0 out
 */
export function simulateRaydiumCLMMSwapExactIn(
    pool: RaydiumCLMMPoolState,
    config: RaydiumAmmConfigState,
    tickArrays: RaydiumTickArrayState[],
    amountIn: bigint,
    zeroForOne: boolean,
    sqrtPriceLimitX64?: bigint
): CLMMSwapResult {
    if (pool.status !== 0) {
        throw new Error(`Pool not active: status=${pool.status}`);
    }

    if (amountIn <= 0n) {
        return {
            amountIn,
            amountOut: 0n,
            feeAmount: 0n,
            sqrtPriceAfterX64: pool.sqrtPriceX64,
            tickAfter: pool.tickCurrent,
            liquidityAfter: pool.liquidity,
            ticksCrossed: 0,
        };
    }

    const feeRate = BigInt(config.tradeFeeRate); // u32 -> bigint
    let sqrtPriceX64 = pool.sqrtPriceX64;
    let tickCurrent = pool.tickCurrent;
    let liquidity = pool.liquidity;

    const ticks = buildInitializedTickList(tickArrays);

    const limit =
        sqrtPriceLimitX64 ??
        (zeroForOne ? getSqrtPriceX64AtTick(MIN_TICK) : getSqrtPriceX64AtTick(MAX_TICK));

    let amountRemaining = amountIn;
    let amountOut = 0n;
    let feeAmount = 0n;
    let ticksCrossed = 0;

    const MAX_STEPS = 10_000;

    for (
        let stepCount = 0;
        stepCount < MAX_STEPS && amountRemaining > 0n && liquidity > 0n;
        stepCount++
    ) {
        if (zeroForOne && sqrtPriceX64 <= limit) break;
        if (!zeroForOne && sqrtPriceX64 >= limit) break;

        const next = nextInitializedTick(ticks, tickCurrent, zeroForOne);
        const nextTick = next ? next.tick : zeroForOne ? MIN_TICK : MAX_TICK;
        const sqrtAtNextTick = getSqrtPriceX64AtTick(nextTick);

        const sqrtTarget = zeroForOne
            ? (sqrtAtNextTick < limit ? limit : sqrtAtNextTick)
            : (sqrtAtNextTick > limit ? limit : sqrtAtNextTick);

        const s = computeSwapStepExactIn(
            sqrtPriceX64,
            sqrtTarget,
            liquidity,
            amountRemaining,
            feeRate,
            zeroForOne
        );

        const consumedGross = s.amountIn + s.feeAmount;
        if (consumedGross > amountRemaining) {
            throw new Error(
                `Consumed > remaining: consumed=${consumedGross} remaining=${amountRemaining}`
            );
        }

        amountRemaining -= consumedGross;
        amountOut += s.amountOut;
        feeAmount += s.feeAmount;
        sqrtPriceX64 = s.sqrtPriceNextX64;

        const reachedTarget = sqrtPriceX64 === sqrtTarget;
        const reachedTickBoundary = reachedTarget && sqrtTarget === sqrtAtNextTick && next !== null;

        if (reachedTickBoundary) {
            const liqNet = next!.liquidityNet;

            if (zeroForOne) {
                liquidity = liquidity - liqNet;
                tickCurrent = nextTick - 1;
            } else {
                liquidity = liquidity + liqNet;
                tickCurrent = nextTick;
            }

            if (liquidity < 0n) throw new Error(`Liquidity underflow after crossing tick ${nextTick}`);
            ticksCrossed++;
            continue;
        }

        // swap ended inside current range
        break;
    }

    const tickAfter = getTickAtSqrtPriceX64(sqrtPriceX64);

    return {
        amountIn,
        amountOut,
        feeAmount,
        sqrtPriceAfterX64: sqrtPriceX64,
        tickAfter,
        liquidityAfter: liquidity,
        ticksCrossed,
    };
}
