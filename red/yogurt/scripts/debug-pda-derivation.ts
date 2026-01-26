/**
 * Debug PDA derivation for tick arrays
 *
 * Computes expected tick array PDAs and checks if RPC returns null
 */

import { PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';

const SESSION_ID = '5f4be931-95d4-469c-ba20-2930a4954f25';
const POOL_PUBKEY_HEX = '0938d510e865189c2ea81f094165132cfc67b4c09f615afac1e59daececf4a91';

const CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const TICKS_PER_ARRAY = 60;

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

function deriveTickArrayPDA(poolId: Uint8Array, startTickIndex: number): PublicKey {
    const seed = Buffer.alloc(4);
    seed.writeInt32LE(startTickIndex, 0);

    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('tick_array'),
            Buffer.from(poolId),
            seed,
        ],
        CLMM_PROGRAM_ID
    );

    return pda;
}

async function main() {
    const db = new Database('./data/evidence/capture.db', { readonly: true });

    console.log('=== PDA Derivation Debug ===\n');

    const poolPubkey = hexToBytes(POOL_PUBKEY_HEX);

    // Expected tick arrays for this pool (from debug-tick-arrays.ts)
    const expectedArrays = [82500, 82560, 82620, 82680, 82740, 82800, 82860];

    console.log('Pool pubkey:', POOL_PUBKEY_HEX);
    console.log('Expected tick array startIndexes:', expectedArrays);
    console.log('\n=== Derived PDAs ===\n');

    for (const startIdx of expectedArrays) {
        const pda = deriveTickArrayPDA(poolPubkey, startIdx);
        const pdaHex = Buffer.from(pda.toBytes()).toString('hex');

        // Check if this PDA was fetched in bootstrap_updates
        const bootstrapRow = db.prepare(`
            SELECT pubkey, slot, CASE WHEN data_b64 IS NOT NULL THEN 'YES' ELSE 'NO' END as has_data
            FROM bootstrap_updates
            WHERE session_id = ? AND pubkey = ? AND account_type = 'tick'
            LIMIT 1
        `).get(SESSION_ID, pdaHex) as { pubkey: string; slot: number; has_data: string } | undefined;

        console.log(`startIdx=${startIdx}:`);
        console.log(`  PDA: ${pda.toBase58()}`);
        console.log(`  Hex: ${pdaHex.slice(0, 32)}...`);
        if (bootstrapRow) {
            console.log(`  Bootstrap: slot=${bootstrapRow.slot}, has_data=${bootstrapRow.has_data}`);
        } else {
            console.log(`  Bootstrap: NOT FOUND in bootstrap_updates`);
        }
        console.log();
    }

    // Also check the boundary tick arrays that ARE being received
    console.log('\n=== Boundary Tick Array PDAs ===\n');

    for (const startIdx of [443580, -443640]) {
        const pda = deriveTickArrayPDA(poolPubkey, startIdx);
        const pdaHex = Buffer.from(pda.toBytes()).toString('hex');

        // Check if this PDA appears in cache_traces
        const cacheRow = db.prepare(`
            SELECT COUNT(*) as count
            FROM cache_traces
            WHERE session_id = ? AND cache_type = 'tick' AND pubkey = ?
        `).get(SESSION_ID, pdaHex) as { count: number };

        console.log(`startIdx=${startIdx}:`);
        console.log(`  PDA: ${pda.toBase58()}`);
        console.log(`  Hex: ${pdaHex.slice(0, 32)}...`);
        console.log(`  gRPC updates in cache_traces: ${cacheRow.count}`);
        console.log();
    }

    // Verify by fetching actual tick array pubkeys from cache_traces
    console.log('\n=== Actual Tick Array Pubkeys from gRPC ===\n');

    const actualArrays = db.prepare(`
        SELECT DISTINCT pubkey, cache_key
        FROM cache_traces
        WHERE session_id = ? AND cache_type = 'tick' AND cache_key LIKE ?
        ORDER BY cache_key
    `).all(SESSION_ID, POOL_PUBKEY_HEX + '%') as { pubkey: string; cache_key: string }[];

    for (const row of actualArrays) {
        const startIdx = row.cache_key.split(':')[1];
        console.log(`startIdx=${startIdx}:`);
        console.log(`  Pubkey: ${row.pubkey.slice(0, 32)}...`);

        // Derive what the PDA SHOULD be
        const expectedPda = deriveTickArrayPDA(poolPubkey, parseInt(startIdx!));
        const expectedHex = Buffer.from(expectedPda.toBytes()).toString('hex');
        const matches = expectedHex === row.pubkey;

        console.log(`  Expected: ${expectedHex.slice(0, 32)}...`);
        console.log(`  Match: ${matches ? 'YES' : 'NO <<<'}`);
        console.log();
    }

    db.close();
}

main().catch(console.error);
