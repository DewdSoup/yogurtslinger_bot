// src/decoders/splToken.ts
export const SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET = 64; // u64 amount @ 64

export function decodeSplTokenAccountAmount(data: Buffer): bigint {
    if (data.length < SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
        throw new Error(
            `[decodeSplTokenAccountAmount] Buffer too short: got ${data.length}`
        );
    }
    return data.readBigUInt64LE(SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET);
}
