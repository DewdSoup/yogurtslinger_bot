// src/decoders/pumpFeesFeeConfig.ts
//
// Pump Fees (pump_fees) FeeConfig decoder + PDA helper.
// Program: pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
//
// UPDATED: Fixed 40-byte tier stride (5×u64) based on on-chain analysis.
// OPTIMIZED: Tiers sorted at decode time, selectTierFeesLowerBoundFast() for hot path.

import { PublicKey } from "@solana/web3.js";

export const PUMP_FEES_PROGRAM_ID = new PublicKey(
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
);

// sha256("account:FeeConfig").slice(0,8) = 8f3492bbdb7b4c9b
export const FEE_CONFIG_DISCRIMINATOR = Buffer.from("8f3492bbdb7b4c9b", "hex");

const MAX_FEE_TIERS = 64;

export interface PumpFeesFeesBps {
    lpFeeBps: bigint;          // u64
    protocolFeeBps: bigint;    // u64
    coinCreatorFeeBps: bigint; // u64
}

// Alias for sims so they can import a single name.
export type PumpSwapFeesBps = PumpFeesFeesBps;

export interface PumpFeesFeeTier {
    // Keep both names to prevent repo-wide naming drift from breaking builds.
    marketCapLamportsThreshold: bigint; // u64 (canonical)
    marketCapThreshold: bigint;         // u64 (compat alias)
    fees: PumpFeesFeesBps;

    // Extra u64 observed per-tier in raw bytes (often looks like 0..100).
    // Meaning is not required for swap pricing, but we preserve it.
    extraU64: bigint;
}

export interface PumpFeesFeeConfig {
    bump: number; // u8
    admin: PublicKey; // Pubkey
    flatFees: PumpFeesFeesBps;
    feeTiers: PumpFeesFeeTier[]; // ALWAYS sorted ascending by threshold at decode time
}

class BorshReader {
    private o = 0;
    constructor(private readonly buf: Buffer) { }

    private ensure(size: number) {
        if (this.o + size > this.buf.length) {
            throw new Error(
                `[FeeConfig] buffer underrun at ${this.o}, need ${size}, len ${this.buf.length}`
            );
        }
    }

    readU8(): number {
        this.ensure(1);
        const v = this.buf.readUInt8(this.o);
        this.o += 1;
        return v;
    }

    readU32(): number {
        this.ensure(4);
        const v = this.buf.readUInt32LE(this.o);
        this.o += 4;
        return v;
    }

    readU64(): bigint {
        this.ensure(8);
        const v = this.buf.readBigUInt64LE(this.o);
        this.o += 8;
        return v;
    }

    readPubkey(): PublicKey {
        this.ensure(32);
        const pk = new PublicKey(this.buf.subarray(this.o, this.o + 32));
        this.o += 32;
        return pk;
    }

    readVec<T>(readOne: () => T): T[] {
        const len = this.readU32();
        if (len > MAX_FEE_TIERS) {
            throw new Error(`[FeeConfig] Vec length too large: ${len} > ${MAX_FEE_TIERS}`);
        }
        const out: T[] = [];
        for (let i = 0; i < len; i++) out.push(readOne());
        return out;
    }
}

function readFeesBps(r: BorshReader): PumpFeesFeesBps {
    const lpFeeBps = r.readU64();
    const protocolFeeBps = r.readU64();
    const coinCreatorFeeBps = r.readU64();
    return { lpFeeBps, protocolFeeBps, coinCreatorFeeBps };
}

/**
 * Fee tier layout (based on observed 40-byte stride):
 *   u64 thresholdLamports
 *   u64 a
 *   u64 b
 *   u64 c
 *   u64 d
 *
 * In the sample data, many tiers look like:
 *   [threshold, 0, 20, 5, 95], [threshold, 0, 20, 5, 90], ...
 *
 * We map (a,b,c) into (coinCreatorFeeBps, lpFeeBps, protocolFeeBps) because:
 *   - 'a' is 0 in many tiers (matches typical creator-fee-bps=0)
 *   - 'b' and 'c' are small bps-like numbers (20,5) that match empirical histograms
 *   - 'd' looks percent-like (95,90,85...) and is not needed for pricing
 */
function readFeeTierV2_40B(r: BorshReader): PumpFeesFeeTier {
    const thresholdLamports = r.readU64();
    const a = r.readU64(); // coinCreatorFeeBps (often 0)
    const b = r.readU64(); // lpFeeBps (often 20)
    const c = r.readU64(); // protocolFeeBps (often 5)
    const d = r.readU64(); // extra field (95, 90, 85... not used for pricing)

    const fees: PumpFeesFeesBps = {
        lpFeeBps: b,
        protocolFeeBps: c,
        coinCreatorFeeBps: a,
    };

    return {
        marketCapLamportsThreshold: thresholdLamports,
        marketCapThreshold: thresholdLamports, // compat alias
        fees,
        extraU64: d,
    };
}

export function deriveFeeConfigPda(configProgramId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee_config"), configProgramId.toBuffer()],
        PUMP_FEES_PROGRAM_ID
    );
    return pda;
}

export function isFeeConfigAccount(data: Buffer): boolean {
    return data.length >= 8 && data.subarray(0, 8).equals(FEE_CONFIG_DISCRIMINATOR);
}

export function decodeFeeConfig(data: Buffer): PumpFeesFeeConfig {
    if (data.length < 8) throw new Error(`[FeeConfig] too small: ${data.length}`);
    if (!isFeeConfigAccount(data)) {
        throw new Error(`[FeeConfig] bad discriminator: ${data.subarray(0, 8).toString("hex")}`);
    }

    const r = new BorshReader(data.subarray(8)); // skip discriminator

    const bump = r.readU8();
    const admin = r.readPubkey();
    const flatFees = readFeesBps(r);
    const feeTiers = r.readVec(() => readFeeTierV2_40B(r));

    // OPTIMIZATION: Sort tiers ascending by threshold at decode time.
    // This allows selectTierFeesLowerBoundFast() to skip allocation/sort on hot path.
    feeTiers.sort((a, b) =>
        a.marketCapLamportsThreshold < b.marketCapLamportsThreshold ? -1 :
            a.marketCapLamportsThreshold > b.marketCapLamportsThreshold ? 1 : 0
    );

    return { bump, admin, flatFees, feeTiers };
}

/**
 * FAST hot-path tier selector. Assumes tiers are pre-sorted ascending by threshold.
 * No allocation, no sort. O(n) scan but n is small (typically 25 tiers).
 *
 * Lower-bound selection: choose the highest tier where marketCap >= threshold.
 */
export function selectTierFeesLowerBoundFast(
    sortedTiers: PumpFeesFeeTier[],
    marketCapLamports: bigint
): PumpFeesFeesBps | null {
    if (sortedTiers.length === 0) return null;

    let chosen = sortedTiers[0]!;
    for (const t of sortedTiers) {
        if (marketCapLamports >= t.marketCapLamportsThreshold) chosen = t;
        else break;
    }
    return chosen.fees;
}

/**
 * Lower-bound selector: choose the highest tier where marketCap >= threshold.
 * NOTE: This version sorts defensively. For hot path, use selectTierFeesLowerBoundFast()
 * with pre-sorted tiers from decodeFeeConfig().
 * 
 * @deprecated Use selectTierFeesLowerBoundFast() for hot path - this allocates and sorts.
 */
export function selectTierFeesLowerBound(
    tiers: PumpFeesFeeTier[],
    marketCapLamports: bigint
): PumpFeesFeesBps | null {
    if (tiers.length === 0) return null;

    // Sort ascending by threshold (defensive, in case account is unsorted)
    const sorted = [...tiers].sort((a, b) =>
        a.marketCapLamportsThreshold === b.marketCapLamportsThreshold
            ? 0
            : a.marketCapLamportsThreshold < b.marketCapLamportsThreshold
                ? -1
                : 1
    );

    let chosen = sorted[0]!;
    for (const t of sorted) {
        if (marketCapLamports >= t.marketCapLamportsThreshold) chosen = t;
        else break;
    }
    return chosen.fees;
}

/**
 * Upper-bound selector: choose the first tier where marketCap <= threshold.
 * Keep this available because tier[0] entry is weird, and the on-chain program
 * might be using an upper-bound policy.
 */
export function selectTierFeesUpperBound(
    tiers: PumpFeesFeeTier[],
    marketCapLamports: bigint
): PumpFeesFeesBps | null {
    if (tiers.length === 0) return null;

    const sorted = [...tiers].sort((a, b) =>
        a.marketCapLamportsThreshold === b.marketCapLamportsThreshold
            ? 0
            : a.marketCapLamportsThreshold < b.marketCapLamportsThreshold
                ? -1
                : 1
    );

    for (const t of sorted) {
        if (marketCapLamports <= t.marketCapLamportsThreshold) return t.fees;
    }
    return sorted[sorted.length - 1]!.fees;
}

/**
 * Combined selector with fallback to flat fees.
 * Uses fast path since feeTiers are pre-sorted at decode time.
 */
export function selectPumpSwapFeesForMarketCap(
    cfg: PumpFeesFeeConfig,
    marketCapLamports: bigint
): PumpSwapFeesBps {
    // feeTiers are pre-sorted at decode time, so use fast path
    const t = selectTierFeesLowerBoundFast(cfg.feeTiers, marketCapLamports);
    return t ?? cfg.flatFees;
}

/**
 * Fee charged to the trader for swap math.
 *
 * The mismatch profile (systematically off by ~5 bps in many cases) is exactly what you get
 * if you treat protocolFeeBps as *additive* to lpFeeBps in the constant-product math.
 *
 * Use lpFeeBps + protocolFeeBps as the "trade fee" in the swap formula.
 * This matches the observed 25 bps (20 + 5) for standard pools.
 */
export function tradeFeeBps(f: PumpFeesFeesBps): bigint {
    return f.lpFeeBps + f.protocolFeeBps;
}

/**
 * Total configured fee bps including creator fee.
 * Note: Creator fee is typically NOT charged on AMM swaps.
 */
export function totalConfiguredFeeBps(f: PumpFeesFeesBps): bigint {
    return f.lpFeeBps + f.protocolFeeBps + f.coinCreatorFeeBps;
}