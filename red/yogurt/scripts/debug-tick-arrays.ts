/**
 * Debug script to analyze tick array discrepancy
 *
 * Investigates why bootstrap tick arrays don't match gRPC tick arrays
 */

import Database from 'better-sqlite3';

const SESSION_ID = '5f4be931-95d4-469c-ba20-2930a4954f25';
const POOL_PUBKEY = '0938d510e865189c2ea81f094165132cfc67b4c09f615afac1e59daececf4a91';

// Raydium CLMM pool field offsets
const TICK_SPACING_OFFSET = 235;  // u16
const TICK_CURRENT_OFFSET = 269;  // i32
const LIQUIDITY_OFFSET = 237;     // u128

function decodePoolFields(data: Buffer): { tickSpacing: number; tickCurrent: number; liquidity: bigint } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const tickSpacing = view.getUint16(TICK_SPACING_OFFSET, true);
    const tickCurrent = view.getInt32(TICK_CURRENT_OFFSET, true);

    // Read liquidity u128
    const lo = view.getBigUint64(LIQUIDITY_OFFSET, true);
    const hi = view.getBigUint64(LIQUIDITY_OFFSET + 8, true);
    const liquidity = lo + (hi << 64n);

    return { tickSpacing, tickCurrent, liquidity };
}

function getTickArrayStartIndex(tick: number, tickSpacing: number): number {
    const ticksPerArray = 60 * tickSpacing;
    return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

async function main() {
    const db = new Database('./data/evidence/capture.db', { readonly: true });

    console.log('=== Tick Array Discrepancy Analysis ===\n');

    // 1. Get pool data from mainnet_updates
    const poolRow = db.prepare(`
        SELECT data_b64, slot
        FROM mainnet_updates
        WHERE session_id = ? AND pubkey = ?
        ORDER BY slot
        LIMIT 1
    `).get(SESSION_ID, POOL_PUBKEY) as { data_b64: string; slot: number } | undefined;

    if (!poolRow) {
        console.log('Pool not found in mainnet_updates');
        return;
    }

    const poolData = Buffer.from(poolRow.data_b64, 'base64');
    console.log(`Pool data length: ${poolData.length} bytes`);
    console.log(`Pool slot: ${poolRow.slot}\n`);

    // 2. Decode pool fields
    const { tickSpacing, tickCurrent, liquidity } = decodePoolFields(poolData);

    console.log('=== Decoded Pool Fields ===');
    console.log(`tickSpacing: ${tickSpacing}`);
    console.log(`tickCurrent: ${tickCurrent}`);
    console.log(`liquidity: ${liquidity}`);

    // 3. Calculate expected tick array range
    const centerStart = getTickArrayStartIndex(tickCurrent, tickSpacing);
    const ticksPerArray = 60 * tickSpacing;

    console.log('\n=== Expected Tick Array Range ===');
    console.log(`ticksPerArray: ${ticksPerArray}`);
    console.log(`centerStart: ${centerStart}`);

    const expectedArrays = [];
    for (let offset = -3; offset <= 3; offset++) {
        expectedArrays.push(centerStart + offset * ticksPerArray);
    }
    console.log(`Expected arrays: [${expectedArrays.join(', ')}]`);

    // 4. Get what frozen_topologies recorded
    const frozenRow = db.prepare(`
        SELECT required_tick_arrays
        FROM frozen_topologies
        WHERE session_id = ? AND pool_pubkey = ?
        LIMIT 1
    `).get(SESSION_ID, POOL_PUBKEY) as { required_tick_arrays: string } | undefined;

    if (frozenRow) {
        console.log(`\nFrozen required arrays: ${frozenRow.required_tick_arrays}`);
    }

    // 5. Get what gRPC actually sent
    const grpcArrays = db.prepare(`
        SELECT DISTINCT cache_key
        FROM cache_traces
        WHERE session_id = ? AND cache_type = 'tick' AND cache_key LIKE ?
    `).all(SESSION_ID, POOL_PUBKEY + '%') as { cache_key: string }[];

    console.log('\n=== gRPC Tick Arrays Received ===');
    for (const row of grpcArrays) {
        const startIdx = row.cache_key.split(':')[1];
        console.log(`  ${startIdx}`);
    }

    // 6. Analysis
    console.log('\n=== Analysis ===');
    const grpcStartIndexes = grpcArrays.map(r => parseInt(r.cache_key.split(':')[1]!));

    if (grpcStartIndexes.length > 0) {
        const minGrpc = Math.min(...grpcStartIndexes);
        const maxGrpc = Math.max(...grpcStartIndexes);
        console.log(`gRPC range: ${minGrpc} to ${maxGrpc}`);
        console.log(`Expected center: ${centerStart}`);
        console.log(`Distance: ${Math.abs(centerStart - minGrpc)} ticks`);

        // Check if gRPC arrays are at boundary ticks
        const MAX_TICK = 443636;
        const MIN_TICK = -443636;

        for (const idx of grpcStartIndexes) {
            if (Math.abs(idx) > 400000) {
                console.log(`\n!!! Array at ${idx} is near boundary (MAX_TICK=${MAX_TICK})`);
            }
        }
    }

    // 7. Sample more CLMM pools
    console.log('\n\n=== Sample of Other CLMM Pools ===');
    const otherPools = db.prepare(`
        SELECT ft.pool_pubkey, ft.required_tick_arrays
        FROM frozen_topologies ft
        WHERE ft.session_id = ? AND ft.venue = 2
        LIMIT 10
    `).all(SESSION_ID) as { pool_pubkey: string; required_tick_arrays: string }[];

    for (const pool of otherPools) {
        // Get gRPC arrays for this pool
        const poolGrpc = db.prepare(`
            SELECT DISTINCT cache_key FROM cache_traces
            WHERE session_id = ? AND cache_type = 'tick' AND cache_key LIKE ?
        `).all(SESSION_ID, pool.pool_pubkey + '%') as { cache_key: string }[];

        const grpcIdxs = poolGrpc.map(r => r.cache_key.split(':')[1]).join(', ');
        console.log(`\nPool: ${pool.pool_pubkey.slice(0, 16)}...`);
        console.log(`  Required: ${pool.required_tick_arrays}`);
        console.log(`  gRPC sent: [${grpcIdxs || 'none'}]`);
    }

    db.close();
}

main().catch(console.error);
