/**
 * Raydium CLMM Pool Decoder (Phase 2) + Swap Instruction Decoder (Phase 5)
 * Program: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
 *
 * Anchor discriminator: f7ede3f5d7c3de46
 *
 * Layout (1544 bytes):
 *   [0..8]     discriminator
 *   [8]        bump
 *   [9..41]    ammConfig (pubkey)
 *   [73..105]  tokenMint0 (pubkey)
 *   [105..137] tokenMint1 (pubkey)
 *   [137..169] tokenVault0 (pubkey)
 *   [169..201] tokenVault1 (pubkey)
 *   [233]      mintDecimals0 (u8)
 *   [234]      mintDecimals1 (u8)
 *   [235..237] tickSpacing (u16)
 *   [237..253] liquidity (u128)
 *   [253..269] sqrtPriceX64 (u128)
 *   [269..273] tickCurrent (i32)
 *   [389]      status (u8)
 *   [390..397] padding (7 bytes)
 *   [397..904] rewardInfos (3 × 169 bytes = 507 bytes)
 *   [904..1032] tickArrayBitmap (16 × u64 = 128 bytes)
 *
 * Swap Instructions (Anchor):
 *   swap:    f8c69e91e17587c8 (deprecated but still used)
 *   swap_v2: 2b04ed0b1ac91e62 (current)
 */

import type { RaydiumClmmPool, CompiledInstruction, SwapLeg } from '../../types.js';
import { VenueId, SwapDirection } from '../../types.js';

// Pool discriminator: f7ede3f5d7c3de46
const POOL_DISC_0 = 0xf7;
const POOL_DISC_1 = 0xed;
const POOL_DISC_2 = 0xe3;
const POOL_DISC_3 = 0xf5;
const POOL_DISC_4 = 0xd7;
const POOL_DISC_5 = 0xc3;
const POOL_DISC_6 = 0xde;
const POOL_DISC_7 = 0x46;

const MIN_SIZE = 1544;

// Swap instruction discriminators (Anchor sighash, 8 bytes)
// swap: sha256("global:swap")[0..8]
const SWAP_DISC = new Uint8Array([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);
// swap_v2: sha256("global:swap_v2")[0..8]
const SWAP_V2_DISC = new Uint8Array([0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62]);

// Swap instruction account indices (swap_v2 layout)
const IDX_POOL_STATE = 2;
const IDX_INPUT_VAULT = 5;
const IDX_OUTPUT_VAULT = 6;
const IDX_INPUT_MINT = 11;
const IDX_OUTPUT_MINT = 12;

const SWAP_MIN_DATA_LEN = 41; // disc(8) + amount(8) + threshold(8) + sqrtPriceLimit(16) + isBaseInput(1)
const SWAP_MIN_ACCOUNTS = 13;

/**
 * Fast discriminator check for pool
 */
export function isRaydiumClmmPool(data: Uint8Array): boolean {
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
 * Read u128 little-endian
 */
function readU128LE(view: DataView, offset: number): bigint {
    const lo = view.getBigUint64(offset, true);
    const hi = view.getBigUint64(offset + 8, true);
    return lo + (hi << 64n);
}

/**
 * Read u128 little-endian from Uint8Array
 */
function readU128LEFromArray(data: Uint8Array, offset: number): bigint {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return readU128LE(view, offset);
}

/**
 * Decode Raydium CLMM pool account
 * Returns null on invalid data (no throw in hot path)
 */
export function decodeRaydiumClmmPool(
    pubkey: Uint8Array,
    data: Uint8Array
): RaydiumClmmPool | null {
    if (!isRaydiumClmmPool(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Extract tickArrayBitmap (16 × u64 at offset 904)
    const tickArrayBitmap = new BigUint64Array(16);
    for (let i = 0; i < 16; i++) {
        tickArrayBitmap[i] = view.getBigUint64(904 + i * 8, true);
    }

    return {
        venue: VenueId.RaydiumClmm,
        pool: pubkey,
        ammConfig: data.slice(9, 41),
        tokenMint0: data.slice(73, 105),
        tokenMint1: data.slice(105, 137),
        tokenVault0: data.slice(137, 169),
        tokenVault1: data.slice(169, 201),
        mintDecimals0: data[233]!,
        mintDecimals1: data[234]!,
        tickSpacing: view.getUint16(235, true),
        liquidity: readU128LE(view, 237),
        sqrtPriceX64: readU128LE(view, 253),
        tickCurrent: view.getInt32(269, true),
        status: data[389]!,
        tickArrayBitmap,
    };
}

// ============================================================================
// TICK ARRAY BITMAP UTILITIES
// ============================================================================

const TICK_ARRAY_SIZE = 60;
const TICK_ARRAY_BITMAP_SIZE = 512; // Number of arrays on each side of center

/**
 * Get the tick array start index for a given tick
 */
export function getTickArrayStartIndex(tick: number, tickSpacing: number): number {
    const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
    return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

/**
 * Get the number of ticks in one tick array
 */
export function getTicksPerArray(tickSpacing: number): number {
    return TICK_ARRAY_SIZE * tickSpacing;
}

/**
 * Get the maximum tick boundary covered by the default bitmap
 * For tickSpacing=1: ±30720 (512 arrays × 60 ticks)
 * For tickSpacing=10: ±307200
 * For tickSpacing=60: ±1843200 (but clamped by MAX_TICK=443636)
 */
export function getMaxTickBoundary(tickSpacing: number): number {
    return TICK_ARRAY_BITMAP_SIZE * TICK_ARRAY_SIZE * tickSpacing;
}

/**
 * Check if a tick array start index is within the default bitmap range
 * Tick arrays outside this range require the TickArrayBitmapExtension account
 */
export function isInDefaultBitmapRange(tickArrayStartIndex: number, tickSpacing: number): boolean {
    const maxBoundary = getMaxTickBoundary(tickSpacing);
    return tickArrayStartIndex >= -maxBoundary && tickArrayStartIndex < maxBoundary;
}

/**
 * Get the bit offset in the bitmap for a given tick array start index
 * The bitmap is centered at 0, with bit 512 representing startIndex=0
 * Negative tick arrays are at bits 0-511, positive at bits 512-1023
 */
export function getBitmapOffset(tickArrayStartIndex: number, tickSpacing: number): number {
    const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
    // Array index relative to 0: tickArrayStartIndex / ticksPerArray
    // Add 512 to shift to bitmap position
    return Math.floor(tickArrayStartIndex / ticksPerArray) + TICK_ARRAY_BITMAP_SIZE;
}

/**
 * Check if a specific tick array is initialized (has liquidity deposited)
 * Uses the bitmap stored in the pool account
 *
 * @param bitmap - 16 × u64 bitmap from pool state
 * @param tickArrayStartIndex - Start index of the tick array to check
 * @param tickSpacing - Pool's tick spacing
 * @returns true if initialized, false if not or out of range
 */
export function isTickArrayInitialized(
    bitmap: BigUint64Array,
    tickArrayStartIndex: number,
    tickSpacing: number
): boolean {
    // Check if in range
    if (!isInDefaultBitmapRange(tickArrayStartIndex, tickSpacing)) {
        // Out of default bitmap range - we'd need TickArrayBitmapExtension
        // For now, return false (not initialized in default bitmap)
        return false;
    }

    const bitOffset = getBitmapOffset(tickArrayStartIndex, tickSpacing);
    if (bitOffset < 0 || bitOffset >= 1024) {
        return false;
    }

    // Find which u64 and which bit within that u64
    const wordIndex = Math.floor(bitOffset / 64);
    const bitIndex = bitOffset % 64;

    const word = bitmap[wordIndex];
    if (word === undefined) return false;

    // Check if bit is set
    return (word & (1n << BigInt(bitIndex))) !== 0n;
}

/**
 * Get all initialized tick array start indexes within a range around current tick
 * This is the critical function that replaces blind ±radius fetching
 *
 * @param bitmap - 16 × u64 bitmap from pool state
 * @param tickCurrent - Pool's current tick
 * @param tickSpacing - Pool's tick spacing
 * @param radius - Number of arrays on each side to check (default: 7)
 * @returns Array of initialized tick array start indexes
 */
export function getInitializedTickArraysInRange(
    bitmap: BigUint64Array,
    tickCurrent: number,
    tickSpacing: number,
    radius: number = 7
): number[] {
    const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
    const currentArrayStart = getTickArrayStartIndex(tickCurrent, tickSpacing);

    const initialized: number[] = [];

    // Check ±radius arrays around current position
    for (let offset = -radius; offset <= radius; offset++) {
        const startIndex = currentArrayStart + offset * ticksPerArray;

        if (isTickArrayInitialized(bitmap, startIndex, tickSpacing)) {
            initialized.push(startIndex);
        }
    }

    return initialized;
}

/**
 * Scan the entire bitmap for all initialized tick arrays
 * Useful for debugging and analysis
 *
 * @param bitmap - 16 × u64 bitmap from pool state
 * @param tickSpacing - Pool's tick spacing
 * @returns Array of all initialized tick array start indexes
 */
export function getAllInitializedTickArrays(
    bitmap: BigUint64Array,
    tickSpacing: number
): number[] {
    const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
    const initialized: number[] = [];

    // Scan all 1024 bits
    for (let wordIndex = 0; wordIndex < 16; wordIndex++) {
        const word = bitmap[wordIndex];
        if (word === undefined || word === 0n) continue;

        for (let bitIndex = 0; bitIndex < 64; bitIndex++) {
            if ((word & (1n << BigInt(bitIndex))) !== 0n) {
                // Convert bit position back to tick array start index
                const bitOffset = wordIndex * 64 + bitIndex;
                const arrayIndex = bitOffset - TICK_ARRAY_BITMAP_SIZE;
                const startIndex = arrayIndex * ticksPerArray;
                initialized.push(startIndex);
            }
        }
    }

    return initialized.sort((a, b) => a - b);
}

/**
 * Count how many tick arrays are initialized in the bitmap
 */
export function countInitializedTickArrays(bitmap: BigUint64Array): number {
    let count = 0;
    for (let i = 0; i < 16; i++) {
        const word = bitmap[i];
        if (word === undefined) continue;
        // Count set bits (population count)
        let n = word;
        while (n !== 0n) {
            count += Number(n & 1n);
            n >>= 1n;
        }
    }
    return count;
}

// ============================================================================
// AMM CONFIG DECODER
// ============================================================================

// AmmConfig discriminator (Anchor): Need to identify from on-chain
// Common fee tiers: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
const AMM_CONFIG_MIN_SIZE = 100;

export interface RaydiumClmmAmmConfig {
    index: number;
    tradeFeeRate: number;      // In hundredths of bps (1e-6)
    protocolFeeRate: number;   // Percentage of trade fee
    tickSpacing: number;
    fundFeeRate: number;
}

/**
 * Common CLMM fee tiers in basis points
 */
export const CLMM_FEE_TIERS = {
    TIER_1: 1n,      // 0.01%
    TIER_4: 4n,      // 0.04%
    TIER_25: 25n,    // 0.25% (most common)
    TIER_100: 100n,  // 1%
} as const;

/**
 * Get default CLMM fee rate
 * Returns 25 bps (0.25%) as default - most common tier
 */
export function getDefaultClmmFeeRate(): bigint {
    return CLMM_FEE_TIERS.TIER_25;
}

/**
 * Convert tradeFeeRate to basis points
 * tradeFeeRate is in 1e-6 units (hundredths of bps)
 */
export function tradeFeeRateToBps(tradeFeeRate: number): bigint {
    return BigInt(Math.round(tradeFeeRate / 100));
}

/**
 * Decode Raydium CLMM ammConfig account
 * Returns null if decode fails
 *
 * Layout (verified against mainnet 2024):
 * [0..8]    Anchor discriminator
 * [8..10]   index (u16)
 * [47..51]  tradeFeeRate (u32) - in 1e-6 (100=1bps, 500=5bps, 2500=25bps)
 * [51..53]  tickSpacing (u16)
 *
 * Note: Other fields exist but only tradeFeeRate is needed for simulation.
 */
export function decodeRaydiumClmmAmmConfig(data: Uint8Array): RaydiumClmmAmmConfig | null {
    if (data.length < AMM_CONFIG_MIN_SIZE) {
        return null;
    }

    try {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

        // Fields at correct offsets (verified against mainnet)
        const index = view.getUint16(8, true);
        const tradeFeeRate = view.getUint32(47, true);  // Correct offset
        const tickSpacing = view.getUint16(51, true);   // Correct offset

        // Sanity check - trade fee shouldn't exceed 10% (10000 = 100 bps)
        const feeBps = tradeFeeRateToBps(tradeFeeRate);
        if (feeBps > 1000) {
            return null;
        }

        return {
            index,
            tradeFeeRate,
            protocolFeeRate: 0,  // Not needed for simulation
            tickSpacing,
            fundFeeRate: 0,      // Not needed for simulation
        };
    } catch {
        return null;
    }
}

/**
 * Get fee rate in basis points from ammConfig
 * Falls back to default if config is null
 */
export function getClmmFeeRate(config: RaydiumClmmAmmConfig | null): bigint {
    if (!config) {
        return getDefaultClmmFeeRate();
    }
    return tradeFeeRateToBps(config.tradeFeeRate);
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
 * Check if instruction is a Raydium CLMM swap
 */
export function isRaydiumClmmSwap(data: Uint8Array): boolean {
    if (data.length < SWAP_MIN_DATA_LEN) return false;
    return discMatch(data, SWAP_DISC) || discMatch(data, SWAP_V2_DISC);
}

/**
 * Decode Raydium CLMM swap instruction
 *
 * Data layout (41 bytes):
 *   [0..8]   discriminator
 *   [8..16]  amount (u64) - input if isBaseInput=true, output otherwise
 *   [16..24] otherAmountThreshold (u64) - slippage bound
 *   [24..40] sqrtPriceLimitX64 (u128) - price limit for partial fills
 *   [40]     isBaseInput (bool) - true = exact input, false = exact output
 *
 * Account layout (swap_v2, 17+ accounts):
 *   0  - payer
 *   1  - ammConfig
 *   2  - poolState
 *   3  - inputTokenAccount
 *   4  - outputTokenAccount
 *   5  - inputVault
 *   6  - outputVault
 *   7  - observationState
 *   8  - tokenProgram (or token0Program)
 *   9  - token1Program (v2 only)
 *   10 - memoProgram
 *   11 - inputTokenMint
 *   12 - outputTokenMint
 *   13+ - tickArrays (remaining accounts for tick traversal)
 */
export function decodeRaydiumClmmInstruction(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[]
): SwapLeg | null {
    const { data, accountKeyIndexes } = instruction;

    // Validate
    if (!isRaydiumClmmSwap(data)) return null;
    if (accountKeyIndexes.length < SWAP_MIN_ACCOUNTS) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Parse instruction data
    const amount = view.getBigUint64(8, true);
    const otherAmountThreshold = view.getBigUint64(16, true);
    const sqrtPriceLimitX64 = readU128LEFromArray(data, 24);
    const isBaseInput = data[40] !== 0;

    // Extract account pubkeys
    const poolIdx = accountKeyIndexes[IDX_POOL_STATE];
    const inputVaultIdx = accountKeyIndexes[IDX_INPUT_VAULT];
    const outputVaultIdx = accountKeyIndexes[IDX_OUTPUT_VAULT];
    const inputMintIdx = accountKeyIndexes[IDX_INPUT_MINT];
    const outputMintIdx = accountKeyIndexes[IDX_OUTPUT_MINT];

    if (poolIdx === undefined || inputVaultIdx === undefined || outputVaultIdx === undefined ||
        inputMintIdx === undefined || outputMintIdx === undefined) {
        return null;
    }

    const pool = accountKeys[poolIdx];
    const inputMint = accountKeys[inputMintIdx];
    const outputMint = accountKeys[outputMintIdx];

    if (!pool || !inputMint || !outputMint) return null;

    // Determine amounts based on isBaseInput
    let inputAmount: bigint;
    let minOutputAmount: bigint;

    if (isBaseInput) {
        // Exact input - amount is input, threshold is min output
        inputAmount = amount;
        minOutputAmount = otherAmountThreshold;
    } else {
        // Exact output - amount is output, threshold is max input
        inputAmount = otherAmountThreshold;  // maxInput
        minOutputAmount = amount;            // exact output
    }

    // Direction: determined by which token is input
    // The instruction explicitly provides input/output mints
    // We need pool state to know if inputMint == token0 (AtoB) or token1 (BtoA)
    // For now, default to AtoB - caller can resolve with pool state

    return {
        venue: VenueId.RaydiumClmm,
        pool,
        direction: SwapDirection.AtoB,  // Placeholder - resolve from pool state
        inputMint,
        outputMint,
        inputAmount,
        minOutputAmount,
        sqrtPriceLimitX64,  // Pass through for accurate simulation
    };
}

/**
 * Decode with pool state for accurate direction
 */
export function decodeRaydiumClmmInstructionWithPool(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[],
    poolState: RaydiumClmmPool
): SwapLeg | null {
    const leg = decodeRaydiumClmmInstruction(instruction, accountKeys);
    if (!leg) return null;

    // Determine direction by comparing inputMint to pool's token0/token1
    const isToken0Input = pubkeyEquals(leg.inputMint, poolState.tokenMint0);
    leg.direction = isToken0Input ? SwapDirection.AtoB : SwapDirection.BtoA;

    return leg;
}

/**
 * Extract sqrtPriceLimitX64 for simulation
 * Returns 0n if no limit (swap to completion)
 */
export function extractSqrtPriceLimit(data: Uint8Array): bigint {
    if (!isRaydiumClmmSwap(data)) return 0n;
    return readU128LEFromArray(data, 24);
}

/**
 * Extract tick array account pubkeys from remaining accounts
 * These are needed for simulation
 */
export function extractTickArrayAccounts(
    instruction: CompiledInstruction,
    accountKeys: Uint8Array[]
): Uint8Array[] {
    const { accountKeyIndexes } = instruction;
    // Tick arrays start at index 13 for swap_v2
    const tickArrays: Uint8Array[] = [];
    for (let i = 13; i < accountKeyIndexes.length; i++) {
        const idx = accountKeyIndexes[i];
        if (idx !== undefined) {
            const key = accountKeys[idx];
            if (key) tickArrays.push(key);
        }
    }
    return tickArrays;
}

// Internal helper
function pubkeyEquals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== 32 || b.length !== 32) return false;
    for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// ============================================================================
// TICK ARRAY BITMAP EXTENSION DECODER
// ============================================================================

/**
 * TickArrayBitmapExtension account structure
 *
 * Handles tick arrays OUTSIDE the pool's default bitmap range (±512 arrays).
 * The extension provides 14 additional bitmap levels on each side.
 *
 * Layout (1832 bytes):
 *   [0..8]      discriminator: [60, 150, 36, 219, 97, 128, 139, 153]
 *   [8..40]     poolId (Pubkey, 32 bytes)
 *   [40..936]   positive_tick_array_bitmap (14 × 8 × u64 = 896 bytes)
 *   [936..1832] negative_tick_array_bitmap (14 × 8 × u64 = 896 bytes)
 */

const EXTENSION_DISCRIMINATOR = new Uint8Array([60, 150, 36, 219, 97, 128, 139, 153]);
const EXTENSION_MIN_SIZE = 1832;
const EXTENSION_BITMAP_SIZE = 14; // 14 levels on each side

export interface TickArrayBitmapExtension {
    poolId: Uint8Array;
    positiveBitmap: BigUint64Array[];  // 14 × 8 u64s each
    negativeBitmap: BigUint64Array[];  // 14 × 8 u64s each
}

/**
 * Check if data is a TickArrayBitmapExtension account
 */
export function isTickArrayBitmapExtension(data: Uint8Array): boolean {
    if (data.length < EXTENSION_MIN_SIZE) return false;
    for (let i = 0; i < 8; i++) {
        if (data[i] !== EXTENSION_DISCRIMINATOR[i]) return false;
    }
    return true;
}

/**
 * Decode TickArrayBitmapExtension account
 */
export function decodeTickArrayBitmapExtension(data: Uint8Array): TickArrayBitmapExtension | null {
    if (!isTickArrayBitmapExtension(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const poolId = data.slice(8, 40);

    // Parse positive bitmap (14 levels × 8 u64s each)
    const positiveBitmap: BigUint64Array[] = [];
    for (let level = 0; level < EXTENSION_BITMAP_SIZE; level++) {
        const levelBitmap = new BigUint64Array(8);
        for (let i = 0; i < 8; i++) {
            const offset = 40 + level * 64 + i * 8;
            levelBitmap[i] = view.getBigUint64(offset, true);
        }
        positiveBitmap.push(levelBitmap);
    }

    // Parse negative bitmap (14 levels × 8 u64s each)
    const negativeBitmap: BigUint64Array[] = [];
    for (let level = 0; level < EXTENSION_BITMAP_SIZE; level++) {
        const levelBitmap = new BigUint64Array(8);
        for (let i = 0; i < 8; i++) {
            const offset = 936 + level * 64 + i * 8;
            levelBitmap[i] = view.getBigUint64(offset, true);
        }
        negativeBitmap.push(levelBitmap);
    }

    return { poolId, positiveBitmap, negativeBitmap };
}

/**
 * Get all initialized tick arrays from the extension bitmap
 *
 * The extension covers tick arrays OUTSIDE the default ±512 range.
 * Each of the 14 levels covers another 512 arrays.
 *
 * @param extension - Decoded extension account
 * @param tickSpacing - Pool's tick spacing
 * @returns Array of initialized tick array start indexes from extension
 */
export function getInitializedTickArraysFromExtension(
    extension: TickArrayBitmapExtension,
    tickSpacing: number
): number[] {
    const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
    const defaultRange = TICK_ARRAY_BITMAP_SIZE * ticksPerArray; // Range covered by default bitmap
    const initialized: number[] = [];

    // Scan positive bitmap (14 levels, each covering 512 arrays)
    for (let level = 0; level < EXTENSION_BITMAP_SIZE; level++) {
        const levelBitmap = extension.positiveBitmap[level];
        if (!levelBitmap) continue;

        // Base offset for this level: defaultRange + level * 512 arrays
        const levelBase = defaultRange + level * TICK_ARRAY_BITMAP_SIZE * ticksPerArray;

        for (let wordIndex = 0; wordIndex < 8; wordIndex++) {
            const word = levelBitmap[wordIndex];
            if (word === undefined || word === 0n) continue;

            for (let bitIndex = 0; bitIndex < 64; bitIndex++) {
                if ((word & (1n << BigInt(bitIndex))) !== 0n) {
                    const arrayOffset = wordIndex * 64 + bitIndex;
                    const startIndex = levelBase + arrayOffset * ticksPerArray;
                    initialized.push(startIndex);
                }
            }
        }
    }

    // Scan negative bitmap (14 levels, each covering 512 arrays)
    for (let level = 0; level < EXTENSION_BITMAP_SIZE; level++) {
        const levelBitmap = extension.negativeBitmap[level];
        if (!levelBitmap) continue;

        // Base offset for this level: -(defaultRange + (level+1) * 512 arrays)
        const levelBase = -(defaultRange + (level + 1) * TICK_ARRAY_BITMAP_SIZE * ticksPerArray);

        for (let wordIndex = 0; wordIndex < 8; wordIndex++) {
            const word = levelBitmap[wordIndex];
            if (word === undefined || word === 0n) continue;

            for (let bitIndex = 0; bitIndex < 64; bitIndex++) {
                if ((word & (1n << BigInt(bitIndex))) !== 0n) {
                    // Negative bitmap bits are in reverse order
                    const arrayOffset = (7 - wordIndex) * 64 + (63 - bitIndex);
                    const startIndex = levelBase + arrayOffset * ticksPerArray;
                    initialized.push(startIndex);
                }
            }
        }
    }

    return initialized.sort((a, b) => a - b);
}

// Moved to fetchPoolDeps.ts where PublicKey is already imported