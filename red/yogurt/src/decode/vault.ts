/**
 * SPL Token Account Decoder (Phase 2)
 * Used to read vault balances for reserve calculation.
 *
 * Layout (165 bytes):
 *   [0..32]   mint (pubkey)
 *   [32..64]  owner (pubkey)
 *   [64..72]  amount (u64)
 *   ...
 */

const TOKEN_ACCOUNT_SIZE = 165;
const AMOUNT_OFFSET = 64;

/**
 * Check if data is SPL token account
 */
export function isTokenAccount(data: Uint8Array): boolean {
    return data.length === TOKEN_ACCOUNT_SIZE;
}

/**
 * Decode SPL token account amount
 * Returns null on invalid data
 */
export function decodeTokenAccountAmount(data: Uint8Array): bigint | null {
    if (data.length < AMOUNT_OFFSET + 8) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return view.getBigUint64(AMOUNT_OFFSET, true);
}

/**
 * Decode full token account (mint, owner, amount)
 */
export function decodeTokenAccount(data: Uint8Array): {
    mint: Uint8Array;
    owner: Uint8Array;
    amount: bigint;
} | null {
    if (data.length < TOKEN_ACCOUNT_SIZE) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
        mint: data.slice(0, 32),
        owner: data.slice(32, 64),
        amount: view.getBigUint64(AMOUNT_OFFSET, true),
    };
}