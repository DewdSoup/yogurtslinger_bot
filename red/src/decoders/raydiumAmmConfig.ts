import { PublicKey } from "@solana/web3.js";

/**
 * Raydium CLMM program id (AmmConfig belongs to CLMM program).
 */
export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);

/**
 * Anchor discriminator for AmmConfig.
 */
export const RAYDIUM_AMM_CONFIG_DISCRIMINATOR = Buffer.from(
    "daf42168cbcb2b6f",
    "hex"
);

export const RAYDIUM_AMM_CONFIG_SIZE = 117;

export const RAYDIUM_AMM_CONFIG_OFFSETS = {
    // discriminator: 0..8
    bump: 8, // u8
    index: 9, // u16
    owner: 11, // pubkey (32)
    protocolFeeRate: 43, // u32
    tradeFeeRate: 47, // u32
    tickSpacing: 51, // u16
    fundFeeRate: 53, // u32
    fundOwner: 57, // pubkey (32)
} as const;

export type RaydiumAmmConfig = {
    address?: PublicKey;

    bump: number;
    index: number;

    owner: PublicKey;

    protocolFeeRate: number; // u32
    tradeFeeRate: number; // u32

    tickSpacing: number; // u16

    fundFeeRate: number; // u32
    fundOwner: PublicKey;
};

function assertRange(buf: Buffer, o: number, n: number, label: string): void {
    if (o < 0 || o + n > buf.length) {
        throw new Error(
            `Raydium AmmConfig decode OOB for ${label}: offset=${o} size=${n} len=${buf.length}`
        );
    }
}

function readU8(buf: Buffer, o: number, label: string): number {
    assertRange(buf, o, 1, label);
    return buf.readUInt8(o);
}
function readU16LE(buf: Buffer, o: number, label: string): number {
    assertRange(buf, o, 2, label);
    return buf.readUInt16LE(o);
}
function readU32LE(buf: Buffer, o: number, label: string): number {
    assertRange(buf, o, 4, label);
    return buf.readUInt32LE(o);
}
function readPubkey(buf: Buffer, o: number, label: string): PublicKey {
    assertRange(buf, o, 32, label);
    return new PublicKey(buf.subarray(o, o + 32));
}

export function isRaydiumAmmConfigAccount(data: Buffer): boolean {
    return (
        data.length >= RAYDIUM_AMM_CONFIG_SIZE &&
        data.subarray(0, 8).equals(RAYDIUM_AMM_CONFIG_DISCRIMINATOR)
    );
}

export function decodeRaydiumAmmConfig(
    data: Buffer,
    address?: PublicKey
): RaydiumAmmConfig {
    if (!isRaydiumAmmConfigAccount(data)) {
        throw new Error(
            `Not a Raydium AmmConfig account: len=${data.length}, disc=${data
                .subarray(0, 8)
                .toString("hex")}`
        );
    }

    const O = RAYDIUM_AMM_CONFIG_OFFSETS;

    return {
        ...(address ? { address } : {}),

        bump: readU8(data, O.bump, "bump"),
        index: readU16LE(data, O.index, "index"),

        owner: readPubkey(data, O.owner, "owner"),

        protocolFeeRate: readU32LE(data, O.protocolFeeRate, "protocolFeeRate"),
        tradeFeeRate: readU32LE(data, O.tradeFeeRate, "tradeFeeRate"),

        tickSpacing: readU16LE(data, O.tickSpacing, "tickSpacing"),

        fundFeeRate: readU32LE(data, O.fundFeeRate, "fundFeeRate"),
        fundOwner: readPubkey(data, O.fundOwner, "fundOwner"),
    };
}

export function tryDecodeRaydiumAmmConfig(
    data: Buffer,
    address?: PublicKey
): RaydiumAmmConfig | null {
    try {
        return decodeRaydiumAmmConfig(data, address);
    } catch {
        return null;
    }
}

export type RaydiumAmmConfigState = RaydiumAmmConfig;
