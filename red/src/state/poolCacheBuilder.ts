// src/state/poolCacheBuilder.ts
//
// Utilities to build cached pool state from validated decoders.
// Use these to populate the HotPathCache.

import { PublicKey } from "@solana/web3.js";
import type { PubkeyStr } from "./accountStore";
import type {
    CachedPumpSwapPool,
    CachedRaydiumV4Pool,
    CachedClmmPool,
    CachedDlmmPool,
} from "./hotPathCache";

// Decoders
import { decodePumpSwapPool } from "../decoders/pumpswapPool";
import { decodePumpSwapGlobalConfig } from "../decoders/pumpswapGlobalConfig";
import { decodeRaydiumV4Pool, V4_POOL_SIZE } from "../decoders/raydiumV4Pool";
import { decodeRaydiumClmmPool } from "../decoders/raydiumCLMMPool";
import {
    deriveRaydiumTickArrayPda,
    getTickArrayStartIndex,
    RAYDIUM_TICKS_PER_ARRAY,
} from "../decoders/raydiumTickArray";
import {
    decodeMeteoraLbPair,
    deriveMeteoraBinArrayPda,
    binIdToBinArrayIndex,
} from "../decoders/meteoraLbPair";

// ============================================================================
// PumpSwap
// ============================================================================

export function buildPumpSwapPool(
    poolAddress: PubkeyStr,
    poolData: Buffer,
    globalConfigData: Buffer,
    slot: number = 0,
    writeVersion: bigint = BigInt(0)
): CachedPumpSwapPool {
    const pool = decodePumpSwapPool(poolData);
    const config = decodePumpSwapGlobalConfig(globalConfigData);

    return {
        venue: "pumpswap",
        poolAddress,
        lastDecodedSlot: slot,
        lastDecodedWriteVersion: writeVersion,
        dirty: false,

        baseVault: pool.poolBaseTokenAccount.toBase58(),
        quoteVault: pool.poolQuoteTokenAccount.toBase58(),

        // Convert bigint basis points to number bps
        lpFeeBps: Number(config.lpFeeBasisPoints),
        protocolFeeBps: Number(config.protocolFeeBasisPoints),
    };
}

// ============================================================================
// Raydium V4
// ============================================================================

export function buildRaydiumV4Pool(
    poolAddress: PubkeyStr,
    poolData: Buffer,
    slot: number = 0,
    writeVersion: bigint = BigInt(0)
): CachedRaydiumV4Pool {
    const pool = decodeRaydiumV4Pool(poolData);

    return {
        venue: "raydium_v4",
        poolAddress,
        lastDecodedSlot: slot,
        lastDecodedWriteVersion: writeVersion,
        dirty: false,

        baseVault: pool.baseVault.toBase58(),
        quoteVault: pool.quoteVault.toBase58(),
        openOrders: pool.openOrders.toBase58(),

        swapFeeNumerator: pool.swapFeeNumerator,
        swapFeeDenominator: pool.swapFeeDenominator,
    };
}

// ============================================================================
// Raydium CLMM
// ============================================================================

/**
 * Build CLMM cached pool.
 * Also computes required tick array PDAs based on current tick.
 */
export function buildClmmPool(
    poolAddress: PubkeyStr,
    poolData: Buffer,
    _ammConfigData: Buffer, // Reserved for future use
    slot: number = 0,
    writeVersion: bigint = BigInt(0)
): CachedClmmPool {
    const pool = decodeRaydiumClmmPool(poolData);
    const poolPubkey = new PublicKey(poolAddress);

    // Compute tick arrays needed for current tick
    const ticksPerArray = pool.tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
    const currentStartIndex = getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing);

    const tickArrayPdas = [
        deriveRaydiumTickArrayPda(poolPubkey, currentStartIndex),
        deriveRaydiumTickArrayPda(poolPubkey, currentStartIndex - ticksPerArray),
        deriveRaydiumTickArrayPda(poolPubkey, currentStartIndex + ticksPerArray),
    ];

    return {
        venue: "raydium_clmm",
        poolAddress,
        lastDecodedSlot: slot,
        lastDecodedWriteVersion: writeVersion,
        dirty: false,

        vault0: pool.tokenVault0.toBase58(),
        vault1: pool.tokenVault1.toBase58(),
        mint0: pool.tokenMint0.toBase58(),
        mint1: pool.tokenMint1.toBase58(),
        ammConfig: pool.ammConfig.toBase58(),
        tickSpacing: pool.tickSpacing,

        tickArrays: tickArrayPdas.map(p => p.toBase58()),
    };
}

/**
 * Update tick array dependencies when tickCurrent changes.
 * Returns new tick array PDAs if they changed, null otherwise.
 */
export function computeNewTickArrays(
    pool: CachedClmmPool,
    newTickCurrent: number
): PubkeyStr[] | null {
    const poolPubkey = new PublicKey(pool.poolAddress);
    const ticksPerArray = pool.tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
    const newStartIndex = getTickArrayStartIndex(newTickCurrent, pool.tickSpacing);

    const newPdas = [
        deriveRaydiumTickArrayPda(poolPubkey, newStartIndex),
        deriveRaydiumTickArrayPda(poolPubkey, newStartIndex - ticksPerArray),
        deriveRaydiumTickArrayPda(poolPubkey, newStartIndex + ticksPerArray),
    ];

    const newAddrs = newPdas.map(p => p.toBase58());

    // Check if any changed
    const existingSet = new Set(pool.tickArrays);
    const hasChange = newAddrs.some(a => !existingSet.has(a));

    return hasChange ? newAddrs : null;
}

// ============================================================================
// Meteora DLMM
// ============================================================================

export function buildDlmmPool(
    pairAddress: PubkeyStr,
    pairData: Buffer,
    slot: number = 0,
    writeVersion: bigint = BigInt(0)
): CachedDlmmPool {
    const pair = decodeMeteoraLbPair(pairData);
    const pairPubkey = new PublicKey(pairAddress);

    // Compute bin arrays needed for current activeId
    const activeArrayIndex = binIdToBinArrayIndex(pair.activeId);

    const binArrayPdas = [
        deriveMeteoraBinArrayPda(pairPubkey, activeArrayIndex),
        deriveMeteoraBinArrayPda(pairPubkey, activeArrayIndex - BigInt(1)),
        deriveMeteoraBinArrayPda(pairPubkey, activeArrayIndex + BigInt(1)),
    ];

    return {
        venue: "meteora_dlmm",
        poolAddress: pairAddress,
        lastDecodedSlot: slot,
        lastDecodedWriteVersion: writeVersion,
        dirty: false,

        reserveX: pair.reserveX.toBase58(),
        reserveY: pair.reserveY.toBase58(),
        mintX: pair.tokenXMint.toBase58(),
        mintY: pair.tokenYMint.toBase58(),
        binStep: pair.binStep,
        baseFactor: pair.baseFactor,

        binArrays: binArrayPdas.map(p => p.toBase58()),
    };
}

/**
 * Update bin array dependencies when activeId changes.
 */
export function computeNewBinArrays(
    pool: CachedDlmmPool,
    newActiveId: number
): PubkeyStr[] | null {
    const pairPubkey = new PublicKey(pool.poolAddress);
    const newArrayIndex = binIdToBinArrayIndex(newActiveId);

    const newPdas = [
        deriveMeteoraBinArrayPda(pairPubkey, newArrayIndex),
        deriveMeteoraBinArrayPda(pairPubkey, newArrayIndex - BigInt(1)),
        deriveMeteoraBinArrayPda(pairPubkey, newArrayIndex + BigInt(1)),
    ];

    const newAddrs = newPdas.map(p => p.toBase58());

    const existingSet = new Set(pool.binArrays);
    const hasChange = newAddrs.some(a => !existingSet.has(a));

    return hasChange ? newAddrs : null;
}

// ============================================================================
// Account Type Detection
// ============================================================================

export type DetectedAccountType =
    | { type: "pumpswap_pool" }
    | { type: "raydium_v4_pool" }
    | { type: "raydium_clmm_pool" }
    | { type: "raydium_clmm_config" }
    | { type: "raydium_clmm_tick_array" }
    | { type: "meteora_lb_pair" }
    | { type: "meteora_bin_array" }
    | { type: "spl_token" }
    | { type: "unknown" };

const PUMPSWAP_POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const CLMM_POOL_DISC = Buffer.from("f7ede3f5d7c3de46", "hex");
const CLMM_CONFIG_DISC = Buffer.from("daf42168cbcb2b6f", "hex");
const CLMM_TICK_ARRAY_DISC = Buffer.from("c09b55cd31f9812a", "hex");
const DLMM_LB_PAIR_DISC = Buffer.from("210b3162b565b10d", "hex");
const DLMM_BIN_ARRAY_DISC = Buffer.from("5c8e5cdc059446b5", "hex");

export function detectAccountType(data: Buffer): DetectedAccountType {
    if (data.length < 8) return { type: "unknown" };

    const disc = data.subarray(0, 8);

    if (disc.equals(PUMPSWAP_POOL_DISC)) return { type: "pumpswap_pool" };
    if (disc.equals(CLMM_POOL_DISC)) return { type: "raydium_clmm_pool" };
    if (disc.equals(CLMM_CONFIG_DISC)) return { type: "raydium_clmm_config" };
    if (disc.equals(CLMM_TICK_ARRAY_DISC)) return { type: "raydium_clmm_tick_array" };
    if (disc.equals(DLMM_LB_PAIR_DISC)) return { type: "meteora_lb_pair" };
    if (disc.equals(DLMM_BIN_ARRAY_DISC)) return { type: "meteora_bin_array" };

    // Raydium V4 has no discriminator, check size
    if (data.length === V4_POOL_SIZE) return { type: "raydium_v4_pool" };

    // SPL Token accounts are 165 bytes
    if (data.length === 165) return { type: "spl_token" };

    return { type: "unknown" };
}
