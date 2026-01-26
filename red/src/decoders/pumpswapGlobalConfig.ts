// src/decoders/pumpswapGlobalConfig.ts

import { PublicKey } from "@solana/web3.js";
import type { PumpSwapFeesBps } from "./pumpFeesFeeConfig";

/**
 * PumpSwap program id.
 */
export const PUMPSWAP_PROGRAM_ID = new PublicKey(
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

/**
 * Anchor discriminator for GlobalConfig.
 * Source: carbon_pump_swap_decoder GlobalConfig DISCRIMINATOR = 0x95089ccaa0fcb0d9
 */
export const PUMPSWAP_GLOBAL_CONFIG_DISCRIMINATOR = Buffer.from(
    "95089ccaa0fcb0d9",
    "hex"
);

export const PUMPSWAP_GLOBAL_CONFIG_MIN_SIZE = 321; // 8 + 32 + 8 + 8 + 1 + (8*32) + 8

export type PumpSwapGlobalConfig = {
    address?: PublicKey;

    admin: PublicKey;

    /** u64 */
    lpFeeBasisPoints: bigint;

    /** u64 */
    protocolFeeBasisPoints: bigint;

    /** u8 bitfield */
    disableFlags: number;

    /** 8 recipients (Pubkey each) */
    protocolFeeRecipients: PublicKey[];

    /** u64 */
    coinCreatorFeeBasisPoints: bigint;
};

function readU8(buf: Buffer, o: number): number {
    return buf.readUInt8(o);
}
function readU64LE(buf: Buffer, o: number): bigint {
    return buf.readBigUInt64LE(o);
}
function readPubkey(buf: Buffer, o: number): PublicKey {
    return new PublicKey(buf.subarray(o, o + 32));
}

export function isPumpSwapGlobalConfigAccount(data: Buffer): boolean {
    return (
        data.length >= PUMPSWAP_GLOBAL_CONFIG_MIN_SIZE &&
        data.subarray(0, 8).equals(PUMPSWAP_GLOBAL_CONFIG_DISCRIMINATOR)
    );
}

export function decodePumpSwapGlobalConfig(
    data: Buffer,
    address?: PublicKey
): PumpSwapGlobalConfig {
    if (!isPumpSwapGlobalConfigAccount(data)) {
        throw new Error(
            `Not a PumpSwap GlobalConfig account: len=${data.length}, disc=${data
                .subarray(0, 8)
                .toString("hex")}`
        );
    }

    // Layout (borsh, no alignment):
    // 0..8   discriminator
    // 8..40  admin (32)
    // 40..48 lp_fee_basis_points (u64)
    // 48..56 protocol_fee_basis_points (u64)
    // 56..57 disable_flags (u8)
    // 57..313 protocol_fee_recipients (8 * 32)
    // 313..321 coin_creator_fee_basis_points (u64)

    const admin = readPubkey(data, 8);
    const lpFeeBasisPoints = readU64LE(data, 40);
    const protocolFeeBasisPoints = readU64LE(data, 48);
    const disableFlags = readU8(data, 56);

    const protocolFeeRecipients: PublicKey[] = new Array(8);
    let off = 57;
    for (let i = 0; i < 8; i++) {
        protocolFeeRecipients[i] = readPubkey(data, off);
        off += 32;
    }

    const coinCreatorFeeBasisPoints = readU64LE(data, 313);

    return {
        ...(address ? { address } : {}),
        admin,
        lpFeeBasisPoints,
        protocolFeeBasisPoints,
        disableFlags,
        protocolFeeRecipients,
        coinCreatorFeeBasisPoints,
    };
}

/**
 * Convert GlobalConfig fees into canonical PumpSwapFeesBps.
 * NOTE: We ignore disableFlags here; routing logic should decide what to do with them.
 */
export function globalConfigToPumpSwapFeesBps(
    cfg: PumpSwapGlobalConfig
): PumpSwapFeesBps {
    return {
        lpFeeBps: cfg.lpFeeBasisPoints,
        protocolFeeBps: cfg.protocolFeeBasisPoints,
        coinCreatorFeeBps: cfg.coinCreatorFeeBasisPoints,
    };
}
