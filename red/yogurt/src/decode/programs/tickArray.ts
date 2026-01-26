/**
 * Raydium CLMM TickArray Decoder (Phase 3)
 * Program: CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
 *
 * Discriminator: c09b55cd31f9812a
 * Size: 10124 bytes (header 44 + 60 ticks × 168 bytes)
 *
 * Layout:
 *   [0..8]    discriminator
 *   [8..40]   poolId (pubkey)
 *   [40..44]  startTickIndex (i32)
 *   [44..]    ticks array (60 × 168 bytes)
 *
 * Tick layout (168 bytes per Raydium CLMM source):
 *   [0..4]    tick (i32)
 *   [4..20]   liquidityNet (i128)
 *   [20..36]  liquidityGross (u128)
 *   [36..52]  feeGrowthOutside0X64 (u128)
 *   [52..68]  feeGrowthOutside1X64 (u128)
 *   [68..168] reward_growths_outside ([u128; 3] = 48 bytes) + padding (52 bytes)
 */

export const TICK_ARRAY_SIZE = 10124;
export const TICKS_PER_ARRAY = 60;
export const TICK_SIZE = 168;

// Discriminator bytes
const DISC_0 = 0xc0;
const DISC_1 = 0x9b;
const DISC_2 = 0x55;
const DISC_3 = 0xcd;
const DISC_4 = 0x31;
const DISC_5 = 0xf9;
const DISC_6 = 0x81;
const DISC_7 = 0x2a;

/** Single tick data needed for simulation */
export interface Tick {
    tick: number;           // i32 tick index
    liquidityNet: bigint;   // i128 - change in liquidity when crossing
    liquidityGross: bigint; // u128 - total liquidity referencing this tick
    initialized: boolean;   // derived: liquidityGross !== 0n
}

/** Decoded TickArray */
export interface TickArray {
    poolId: Uint8Array;
    startTickIndex: number;
    ticks: Tick[];
}

/**
 * Fast discriminator check
 */
export function isTickArray(data: Uint8Array): boolean {
    return data.length >= TICK_ARRAY_SIZE &&
        data[0] === DISC_0 &&
        data[1] === DISC_1 &&
        data[2] === DISC_2 &&
        data[3] === DISC_3 &&
        data[4] === DISC_4 &&
        data[5] === DISC_5 &&
        data[6] === DISC_6 &&
        data[7] === DISC_7;
}

/**
 * Read i128 little-endian (two's complement)
 */
function readI128LE(view: DataView, offset: number): bigint {
    const lo = view.getBigUint64(offset, true);
    const hi = view.getBigUint64(offset + 8, true);
    const u = lo + (hi << 64n);
    const signBit = 1n << 127n;
    return (u & signBit) === 0n ? u : u - (1n << 128n);
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
 * Decode TickArray account
 * Returns null on invalid data
 */
export function decodeTickArray(data: Uint8Array): TickArray | null {
    if (!isTickArray(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const poolId = data.slice(8, 40);
    const startTickIndex = view.getInt32(40, true);

    const ticks: Tick[] = new Array(TICKS_PER_ARRAY);
    const ticksOffset = 44;

    for (let i = 0; i < TICKS_PER_ARRAY; i++) {
        const base = ticksOffset + i * TICK_SIZE;

        const tick = view.getInt32(base, true);
        const liquidityNet = readI128LE(view, base + 4);
        const liquidityGross = readU128LE(view, base + 20);

        ticks[i] = {
            tick,
            liquidityNet,
            liquidityGross,
            initialized: liquidityGross !== 0n,
        };
    }

    return {
        poolId,
        startTickIndex,
        ticks,
    };
}

/**
 * Get the TickArray start index that contains a given tick
 */
export function getTickArrayStartIndex(tickIndex: number, tickSpacing: number): number {
    const ticksPerArray = tickSpacing * TICKS_PER_ARRAY;
    return Math.floor(tickIndex / ticksPerArray) * ticksPerArray;
}

/**
 * Get TickArray index (for subscription key) from startTickIndex
 */
export function getTickArrayIndex(startTickIndex: number, tickSpacing: number): number {
    const ticksPerArray = tickSpacing * TICKS_PER_ARRAY;
    return Math.floor(startTickIndex / ticksPerArray);
}