/**
 * PumpSwap Pool Decoder (Phase 2) + Swap Instruction Decoder (Phase 5)
 * Program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *
 * Layout (211 bytes):
 *   [0..8]    discriminator
 *   [8]       poolBump (u8)
 *   [9..11]   index (u16)
 *   [11..43]  creator (pubkey)
 *   [43..75]  baseMint (pubkey)
 *   [75..107] quoteMint (pubkey)
 *   [107..139] lpMint (pubkey)
 *   [139..171] poolBaseTokenAccount (pubkey) - base vault
 *   [171..203] poolQuoteTokenAccount (pubkey) - quote vault
 *   [203..211] lpSupply (u64)
 *
 * Swap Instructions:
 *   buy:  66063d1201daebea - user buys base with quote
 *   sell: 33e685a4017f83ad - user sells base for quote
 */

import type { PumpSwapPool, CompiledInstruction, SwapLeg } from '../../types.js';
import { VenueId, SwapDirection } from '../../types.js';

// Pool discriminator: f19a6d0411b16dbc
const POOL_DISC_0 = 0xf1;
const POOL_DISC_1 = 0x9a;
const POOL_DISC_2 = 0x6d;
const POOL_DISC_3 = 0x04;
const POOL_DISC_4 = 0x11;
const POOL_DISC_5 = 0xb1;
const POOL_DISC_6 = 0x6d;
const POOL_DISC_7 = 0xbc;

const MIN_SIZE = 211;

// WSOL mint address (So11111111111111111111111111111111111111112 in base58)
// In PumpSwap, quote should always be WSOL. If baseMint is WSOL, we need to swap.
const WSOL_MINT = new Uint8Array([
    0x06, 0x9b, 0x88, 0x57, 0xfe, 0xab, 0x81, 0x84,
    0xfb, 0x68, 0x7f, 0x63, 0x46, 0x18, 0xc0, 0x35,
    0xda, 0xc4, 0x39, 0xdc, 0x1a, 0xeb, 0x3b, 0x55,
    0x98, 0xa0, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x01
]);

/**
 * Check if a mint is WSOL
 */
function isWsol(mint: Uint8Array): boolean {
    if (mint.length !== 32) return false;
    for (let i = 0; i < 32; i++) {
        if (mint[i] !== WSOL_MINT[i]) return false;
    }
    return true;
}

// Swap instruction discriminators (Anchor sighash)
// buy: sha256("global:buy")[0..8] = 66063d1201daebea
const BUY_DISC = new Uint8Array([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
// sell: sha256("global:sell")[0..8] = 33e685a4017f83ad
const SELL_DISC = new Uint8Array([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

// Swap instruction account indices (verified from official pump_amm.json IDL)
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json
const IDX_POOL = 0;
const IDX_BASE_MINT = 3;   // base_mint per IDL
const IDX_QUOTE_MINT = 4;  // quote_mint per IDL
const IDX_BASE_VAULT = 7;  // pool_base_token_account
const IDX_QUOTE_VAULT = 8; // pool_quote_token_account

const SWAP_MIN_DATA_LEN = 24; // disc(8) + amount(8) + threshold(8)
const SWAP_MIN_ACCOUNTS = 11;

/**
 * Fast discriminator check for pool
 */
export function isPumpSwapPool(data: Uint8Array): boolean {
    return data.length >= MIN_SIZE &&
        data[0] === POOL_DISC_0 &&
        data[1] === POOL_DISC_1 &&
        data[2] === POOL_DISC_2 &&
        data[3] === POOL_DISC_3 &&
        data[4] === POOL_DISC_4 &&
        data[5] === POOL_DISC_5 &&
        data[6] === POOL_DISC_6 &&
        data[7] === POOL_DISC_7;
}

/**
 * Decode PumpSwap pool account
 * Returns null on invalid data (no throw in hot path)
 */
export function decodePumpSwapPool(
    pubkey: Uint8Array,
    data: Uint8Array
): PumpSwapPool | null {
    if (!isPumpSwapPool(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Read raw values from pool account
    const rawBaseMint = data.slice(43, 75);
    const rawQuoteMint = data.slice(75, 107);
    const rawBaseVault = data.slice(139, 171);
    const rawQuoteVault = data.slice(171, 203);

    // Normalize: In PumpSwap, quote should always be WSOL (SOL).
    // Some pools have inverted base/quote - detect and swap if needed.
    // If baseMint is WSOL, swap base<->quote to maintain consistent convention.
    const needsSwap = isWsol(rawBaseMint) && !isWsol(rawQuoteMint);

    return {
        venue: VenueId.PumpSwap,
        pool: pubkey,
        baseMint: needsSwap ? rawQuoteMint : rawBaseMint,
        quoteMint: needsSwap ? rawBaseMint : rawQuoteMint,
        lpMint: data.slice(107, 139),
        baseVault: needsSwap ? rawQuoteVault : rawBaseVault,
        quoteVault: needsSwap ? rawBaseVault : rawQuoteVault,
        lpSupply: view.getBigUint64(203, true),
    };
}

// ============================================================================
// SWAP INSTRUCTION DECODER (Phase 5)
// ============================================================================

/**
 * Check 8-byte discriminator match
 */
function discMatch(data: Uint8Array, disc: Uint8Array): boolean {
    for (let i = 0; i < 8; i++) {
        if (data[i] !== disc[i]) return false;
    }
    return true;
}

/**
 * Check if instruction is a PumpSwap swap (buy or sell)
 */
export function isPumpSwapSwap(data: Uint8Array): boolean {
    if (data.length < SWAP_MIN_DATA_LEN) return false;
    return discMatch(data, BUY_DISC) || discMatch(data, SELL_DISC);
}

/**
 * Check if instruction is a buy
 */
export function isPumpSwapBuy(data: Uint8Array): boolean {
    if (data.length < 8) return false;
    return discMatch(data, BUY_DISC);
}

/**
 * Decode PumpSwap swap instruction
 *
 * buy layout (24 bytes):
 *   [0..8]   discriminator
 *   [8..16]  baseAmountOut (u64) - exact base to receive
 *   [16..24] maxQuoteAmountIn (u64) - max quote to spend
 *
 * sell layout (24 bytes):
 *   [0..8]   discriminator
 *   [8..16]  baseAmountIn (u64) - exact base to sell
 *   [16..24] minQuoteAmountOut (u64) - min quote to receive
 *
 * Account layout (verified from official pump_amm.json IDL):
 *   0  - pool
 *   1  - user
 *   2  - globalConfig
 *   3  - baseMint
 *   4  - quoteMint
 *   5  - userBaseTokenAccount
 *   6  - userQuoteTokenAccount
 *   7  - poolBaseTokenAccount (base vault)
 *   8  - poolQuoteTokenAccount (quote vault)
 *   ...
 *
 * NORMALIZATION:
 *   Some pools have inverted base/quote on-chain (WSOL in base position).
 *   We normalize so WSOL is always quote, matching the pool decoder convention.
 *   If baseMint is WSOL: swap mints/vaults. Direction is NOT inverted -
 *   it's determined solely by instruction type (buy=BtoA, sell=AtoB).
 */
export function decodePumpSwapInstruction(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[]
): SwapLeg | null {
    const { data, accountKeyIndexes } = instruction;

    // Validate
    if (!isPumpSwapSwap(data)) return null;
    if (accountKeyIndexes.length < SWAP_MIN_ACCOUNTS) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const isBuy = isPumpSwapBuy(data);

    // Extract account pubkeys (raw on-chain layout)
    const poolIdx = accountKeyIndexes[IDX_POOL];
    const baseMintIdx = accountKeyIndexes[IDX_BASE_MINT];
    const quoteMintIdx = accountKeyIndexes[IDX_QUOTE_MINT];
    const baseVaultIdx = accountKeyIndexes[IDX_BASE_VAULT];
    const quoteVaultIdx = accountKeyIndexes[IDX_QUOTE_VAULT];

    if (poolIdx === undefined || baseMintIdx === undefined || quoteMintIdx === undefined) {
        return null;
    }

    const pool = accountKeys[poolIdx];
    const rawBaseMint = accountKeys[baseMintIdx];
    const rawQuoteMint = accountKeys[quoteMintIdx];
    const rawBaseVault = baseVaultIdx !== undefined ? accountKeys[baseVaultIdx] : undefined;
    const rawQuoteVault = quoteVaultIdx !== undefined ? accountKeys[quoteVaultIdx] : undefined;

    if (!pool || !rawBaseMint || !rawQuoteMint) return null;

    // PS-001 FIX: Normalize so WSOL is always quote (same as pool decoder)
    // If baseMint is WSOL, the pool has inverted layout - swap to normalize
    const needsSwap = isWsol(rawBaseMint) && !isWsol(rawQuoteMint);

    // Apply normalization to mints and vaults
    const baseMint = needsSwap ? rawQuoteMint : rawBaseMint;
    const quoteMint = needsSwap ? rawBaseMint : rawQuoteMint;
    const baseVault = needsSwap ? rawQuoteVault : rawBaseVault;
    const quoteVault = needsSwap ? rawBaseVault : rawQuoteVault;

    let direction: SwapDirection;
    let inputMint: Uint8Array;
    let outputMint: Uint8Array;
    let inputAmount: bigint;
    let minOutputAmount: bigint;
    let exactSide: 'input' | 'output';

    if (isBuy) {
        // Buy: user sends quote (WSOL), receives base (token)
        // Direction is ALWAYS BtoA for buy (quote→base flow)
        // needsSwap only affects mint normalization, NOT direction
        direction = SwapDirection.BtoA;
        inputMint = quoteMint;  // Always WSOL after normalization
        outputMint = baseMint;  // Always token after normalization

        // Data: [baseAmountOut, maxQuoteAmountIn]
        // User specifies EXACT output (baseAmountOut), accepts max input
        const baseAmountOut = view.getBigUint64(8, true);
        const maxQuoteAmountIn = view.getBigUint64(16, true);

        inputAmount = maxQuoteAmountIn;   // MAXIMUM (slippage-protected)
        minOutputAmount = baseAmountOut;  // EXACT (user receives exactly this)
        exactSide = 'output';  // The exact amount is the OUTPUT
    } else {
        // Sell: user sends base (token), receives quote (WSOL)
        // Direction is ALWAYS AtoB for sell (base→quote flow)
        // needsSwap only affects mint normalization, NOT direction
        direction = SwapDirection.AtoB;
        inputMint = baseMint;   // Always token after normalization
        outputMint = quoteMint; // Always WSOL after normalization

        // Data: [baseAmountIn, minQuoteAmountOut]
        // User specifies EXACT input (baseAmountIn), accepts min output
        const baseAmountIn = view.getBigUint64(8, true);
        const minQuoteAmountOut = view.getBigUint64(16, true);

        inputAmount = baseAmountIn;        // EXACT (user sends exactly this)
        minOutputAmount = minQuoteAmountOut; // MINIMUM (slippage-protected)
        exactSide = 'input';  // The exact amount is the INPUT
    }

    return {
        venue: VenueId.PumpSwap,
        pool,
        direction,
        inputMint,
        outputMint,
        inputAmount,
        minOutputAmount,
        exactSide,
        baseVault,
        quoteVault,
    };
}

// ============================================================================
// GLOBAL CONFIG DECODER
// ============================================================================

/**
 * PumpSwap GlobalConfig Account Layout
 *
 * PDA Address: ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw
 * PDA Seeds: ["global_config"]
 *
 * Layout:
 *   [0..8]      discriminator (Anchor)
 *   [8..40]     admin (Pubkey)
 *   [40..48]    lpFeeBasisPoints (u64) - typically 20 bps (0.20%)
 *   [48..56]    protocolFeeBasisPoints (u64) - typically 5 bps (0.05%)
 *   [56..64]    coinCreatorFeeBasisPoints (u64) - variable 0-5 bps
 *   [64..320]   protocolFeeRecipients ([Pubkey; 8])
 *   [320..352]  adminSetCoinCreatorAuthority (Pubkey)
 *   [352..608]  reservedFeeRecipients ([Pubkey; 8])
 *   [608..616]  disableFlags (u64)
 *
 * Total: ~616 bytes minimum
 *
 * Fee Structure:
 *   Total Fee = lpFeeBps + protocolFeeBps + coinCreatorFeeBps
 *   Typical = 20 + 5 + 0-5 = 25-30 bps
 */

// GlobalConfig discriminator: first 8 bytes of sha256("account:GlobalConfig")
// This needs to be verified from on-chain data
const GLOBAL_CONFIG_DISC = new Uint8Array([
    0xfa, 0xf0, 0x84, 0x4a, 0x9b, 0x66, 0x7c, 0x6e
]);

const GLOBAL_CONFIG_MIN_SIZE = 616;

// Field offsets
const OFFSET_ADMIN = 8;
const OFFSET_LP_FEE_BPS = 40;
const OFFSET_PROTOCOL_FEE_BPS = 48;
const OFFSET_CREATOR_FEE_BPS = 56;

export interface PumpSwapGlobalConfig {
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
    coinCreatorFeeBps: bigint;
}

/**
 * GlobalConfig PDA address (singleton)
 * Derived from seeds: ["global_config"] + PumpSwap program ID
 */
export const PUMPSWAP_GLOBAL_CONFIG_PUBKEY = new Uint8Array([
    // ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw in bytes
    0x89, 0x0b, 0xa6, 0x44, 0xfe, 0x1f, 0x55, 0xaa,
    0x19, 0xf1, 0x1c, 0xd2, 0xd2, 0xec, 0x14, 0xd3,
    0x23, 0x3b, 0x6e, 0x0a, 0x4b, 0xea, 0xee, 0xf7,
    0x2b, 0x69, 0x85, 0x8e, 0x21, 0xe1, 0x70, 0xd6
]);

/**
 * Check if data is a GlobalConfig account
 */
export function isPumpSwapGlobalConfig(data: Uint8Array): boolean {
    if (data.length < GLOBAL_CONFIG_MIN_SIZE) return false;

    // Check discriminator
    for (let i = 0; i < 8; i++) {
        if (data[i] !== GLOBAL_CONFIG_DISC[i]) return false;
    }
    return true;
}

/**
 * Get default PumpSwap fees
 * Used when GlobalConfig is not available or decode fails.
 *
 * Based on documentation:
 * - LP Fee: 20 bps (0.20%)
 * - Protocol Fee: 5 bps (0.05%)
 * - Creator Fee: 0-5 bps (variable, use 0 as conservative default)
 *
 * Total default: 25 bps (0.25%)
 */
export function getDefaultPumpSwapFees(): PumpSwapGlobalConfig {
    return {
        lpFeeBps: 20n,
        protocolFeeBps: 5n,
        coinCreatorFeeBps: 0n,
    };
}

/**
 * Decode PumpSwap GlobalConfig account
 *
 * Extracts fee parameters from the singleton GlobalConfig account.
 * Returns default fees if decode fails (defensive for hot path).
 *
 * Note: Fees are stored as u64 on-chain but are always small values (0-100 bps)
 */
export function decodePumpSwapGlobalConfig(data: Uint8Array): PumpSwapGlobalConfig {
    // Size check (allow larger for future-proofing)
    if (data.length < 64) {
        return getDefaultPumpSwapFees();
    }

    try {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        const lpFeeBps = view.getBigUint64(OFFSET_LP_FEE_BPS, true);
        const protocolFeeBps = view.getBigUint64(OFFSET_PROTOCOL_FEE_BPS, true);
        const coinCreatorFeeBps = view.getBigUint64(OFFSET_CREATOR_FEE_BPS, true);

        // Validate: fees should be reasonable (0-1000 bps = 0-10%)
        if (lpFeeBps <= 1000n && protocolFeeBps <= 1000n && coinCreatorFeeBps <= 1000n) {
            return { lpFeeBps, protocolFeeBps, coinCreatorFeeBps };
        }

        // If fees look wrong, fall through to default
    } catch {
        // Fall through to default
    }

    return getDefaultPumpSwapFees();
}

/**
 * Get total fee in basis points from GlobalConfig
 */
export function getPumpSwapTotalFeeBps(config: PumpSwapGlobalConfig): bigint {
    return config.lpFeeBps + config.protocolFeeBps + config.coinCreatorFeeBps;
}