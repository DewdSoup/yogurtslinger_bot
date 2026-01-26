// src/decoders/pump.ts

export interface PumpBondingCurveState {
    discriminator: bigint;
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    tokenTotalSupply: bigint;
    complete: boolean;
}

/**
 * Minimum bytes needed for the core Pump curve fields:
 * 6 × u64 (48 bytes) + 1 × bool (1 byte) = 49 bytes.
 * We accept any account with length >= 49 and ignore trailing bytes.
 */
const MIN_PUMP_CURVE_ACCOUNT_LEN = 49;

export function decodePumpAccount(
    data: Buffer | Uint8Array
): PumpBondingCurveState {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buffer.length < MIN_PUMP_CURVE_ACCOUNT_LEN) {
        throw new Error(
            `[decodePumpAccount] Buffer too short for Pump curve: ` +
            `got ${buffer.length}, need at least ${MIN_PUMP_CURVE_ACCOUNT_LEN}`
        );
    }

    let offset = 0;

    const discriminator = buffer.readBigUInt64LE(offset);
    offset += 8;

    const virtualTokenReserves = buffer.readBigUInt64LE(offset);
    offset += 8;

    const virtualSolReserves = buffer.readBigUInt64LE(offset);
    offset += 8;

    const realTokenReserves = buffer.readBigUInt64LE(offset);
    offset += 8;

    const realSolReserves = buffer.readBigUInt64LE(offset);
    offset += 8;

    const tokenTotalSupply = buffer.readBigUInt64LE(offset);
    offset += 8;

    // Old strict behavior (which caused "Invalid bool: 151") enforced 0/1.
    // New behavior: treat any non-zero byte as true.
    const completeByte = buffer.readUInt8(offset);
    const complete = completeByte !== 0;

    return {
        discriminator,
        virtualTokenReserves,
        virtualSolReserves,
        realTokenReserves,
        realSolReserves,
        tokenTotalSupply,
        complete,
    };
}
