// SPL Token Account Layout:
// Offset 0-31:   Mint (32 bytes)
// Offset 32-63:  Owner (32 bytes)
// Offset 64-71:  Amount (8 bytes, u64 LE) ← THE BALANCE
// Offset 72+:    Other fields

export function decodeTokenAccountBalance(data: Buffer | Uint8Array): bigint {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (buffer.length < 72) {
        throw new Error(`Token account too short: ${buffer.length} bytes`);
    }

    return buffer.readBigUInt64LE(64);
}

export function isTokenAccount(data: Buffer | Uint8Array): boolean {
    return data.length >= 165; // Standard SPL token account size
}