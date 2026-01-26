/**
 * Debug tick array raw data
 *
 * Decode the actual tick array to see what poolId is embedded
 */

import { PublicKey } from '@solana/web3.js';
import Database from 'better-sqlite3';

const SESSION_ID = '5f4be931-95d4-469c-ba20-2930a4954f25';
const TICK_ARRAY_PUBKEY = '63d77e0494b043312adf6552d62fa7421d6b11df15da380faf7729f083b80e1a';
const CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

// Expected discriminator for Raydium CLMM tick array
const TICK_ARRAY_DISC = [0xc0, 0x9b, 0x55, 0xcd, 0x31, 0xf9, 0x81, 0x2a];

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

    console.log('=== Tick Array Raw Data Analysis ===\n');
    console.log(`Analyzing tick array: ${TICK_ARRAY_PUBKEY}\n`);

    // Get the raw data from mainnet_updates
    const row = db.prepare(`
        SELECT data_b64, slot
        FROM mainnet_updates
        WHERE session_id = ? AND pubkey = ?
        ORDER BY slot
        LIMIT 1
    `).get(SESSION_ID, TICK_ARRAY_PUBKEY) as { data_b64: string; slot: number } | undefined;

    if (!row) {
        console.log('Tick array not found in mainnet_updates');
        return;
    }

    const data = Buffer.from(row.data_b64, 'base64');
    console.log(`Data length: ${data.length} bytes`);
    console.log(`Slot: ${row.slot}\n`);

    // Check discriminator
    const disc = Array.from(data.slice(0, 8));
    const discMatches = disc.every((b, i) => b === TICK_ARRAY_DISC[i]);
    console.log('=== Discriminator ===');
    console.log(`Expected: [${TICK_ARRAY_DISC.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
    console.log(`Actual:   [${disc.map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`);
    console.log(`Match: ${discMatches ? 'YES' : 'NO <<<'}\n`);

    // Extract poolId (bytes 8-40)
    const poolIdBytes = data.slice(8, 40);
    const poolIdHex = poolIdBytes.toString('hex');
    console.log('=== Pool ID (bytes 8-40) ===');
    console.log(`Hex: ${poolIdHex}`);
    console.log(`Base58: ${new PublicKey(poolIdBytes).toBase58()}\n`);

    // Extract startTickIndex (bytes 40-44)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const startTickIndex = view.getInt32(40, true);
    console.log('=== Start Tick Index (bytes 40-44) ===');
    console.log(`Value: ${startTickIndex}\n`);

    // Now derive what the PDA SHOULD be
    const expectedPDA = deriveTickArrayPDA(poolIdBytes, startTickIndex);
    const expectedPDAHex = Buffer.from(expectedPDA.toBytes()).toString('hex');

    console.log('=== PDA Verification ===');
    console.log(`Tick array address: ${TICK_ARRAY_PUBKEY}`);
    console.log(`Derived PDA:        ${expectedPDAHex}`);
    console.log(`Match: ${expectedPDAHex === TICK_ARRAY_PUBKEY ? 'YES' : 'NO <<<'}\n`);

    if (expectedPDAHex !== TICK_ARRAY_PUBKEY) {
        console.log('!!! PDA MISMATCH !!!');
        console.log('The tick array address does not match the PDA derived from its embedded poolId and startTickIndex.');
        console.log('This means either:');
        console.log('  1. The poolId field is being decoded from wrong offset');
        console.log('  2. The startTickIndex field is being decoded from wrong offset');
        console.log('  3. This is not a standard Raydium CLMM tick array');
        console.log('  4. The tick array was created with different seeds\n');

        // Let's try to find what pool this tick array ACTUALLY belongs to
        // by brute-forcing nearby pools
        console.log('=== Attempting to find actual owner pool ===');

        // Get some CLMM pool pubkeys from frozen_topologies
        const pools = db.prepare(`
            SELECT DISTINCT pool_pubkey
            FROM frozen_topologies
            WHERE session_id = ? AND venue = 2
            LIMIT 50
        `).all(SESSION_ID) as { pool_pubkey: string }[];

        for (const pool of pools) {
            const poolBytes = Buffer.from(pool.pool_pubkey, 'hex');
            const testPDA = deriveTickArrayPDA(poolBytes, startTickIndex);
            if (Buffer.from(testPDA.toBytes()).toString('hex') === TICK_ARRAY_PUBKEY) {
                console.log(`\nFOUND! Tick array belongs to pool: ${pool.pool_pubkey}`);
                console.log(`  (not pool ${poolIdHex} as decoded from data)`);
                break;
            }
        }
    }

    // Also dump first 100 bytes for manual inspection
    console.log('\n=== Raw Data Hex Dump (first 100 bytes) ===');
    for (let i = 0; i < 100; i += 16) {
        const line = data.slice(i, Math.min(i + 16, 100));
        const hex = Array.from(line).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const offset = i.toString(16).padStart(4, '0');
        console.log(`${offset}: ${hex}`);
    }

    db.close();
}

main().catch(console.error);
