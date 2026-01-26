/**
 * Verify PDA derivation for DLMM bin arrays
 *
 * Tests both bitmap interpretations to find the correct one:
 * 1. Current: flatPos - 512 (centered at bit 512)
 * 2. Alternative: flatPos (no offset, bit 0 = index 0)
 */

import { Connection, PublicKey } from '@solana/web3.js';

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const BINS_PER_ARRAY = 70;

// Get pool from command line or use default
const TEST_POOL = process.argv[2] || '';

async function deriveBinArrayPDA(pool: PublicKey, index: number): Promise<PublicKey> {
    const indexBytes = Buffer.alloc(8);
    indexBytes.writeBigInt64LE(BigInt(index), 0);

    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('bin_array'),
            pool.toBuffer(),
            indexBytes,
        ],
        DLMM_PROGRAM_ID
    );
    return pda;
}

async function main() {
    const rpcUrl = process.env.RPC_ENDPOINT || 'http://127.0.0.1:8899';
    const connection = new Connection(rpcUrl, 'confirmed');

    if (!TEST_POOL) {
        // Find a DLMM pool by searching for one
        console.log('No pool specified. Searching for DLMM pools...');

        // Try to get a bin array account and extract the pool from it
        const binArrayAccounts = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
            filters: [{ dataSize: 10136 }],  // BinArray size
            dataSlice: { offset: 0, length: 64 },  // Just get discriminator + lbPair
        });

        if (binArrayAccounts.length === 0) {
            console.log('No bin array accounts found');
            return;
        }

        console.log(`Found ${binArrayAccounts.length} bin array accounts`);

        // Get the lbPair (pool) from first bin array
        const firstBinArray = binArrayAccounts[0];
        const lbPairBytes = firstBinArray.account.data.slice(24, 56);
        const poolPubkey = new PublicKey(lbPairBytes);

        console.log(`\nUsing pool from bin array: ${poolPubkey.toBase58()}`);
        console.log(`Bin array account: ${firstBinArray.pubkey.toBase58()}`);

        // Get the bin array index from the account
        const binArrayData = await connection.getAccountInfo(firstBinArray.pubkey);
        if (!binArrayData) {
            console.log('Could not fetch full bin array data');
            return;
        }

        const view = new DataView(binArrayData.data.buffer, binArrayData.data.byteOffset);
        const binArrayIndex = Number(view.getBigInt64(8, true));
        console.log(`Bin array index: ${binArrayIndex}`);

        // Verify PDA derivation
        const derivedPda = await deriveBinArrayPDA(poolPubkey, binArrayIndex);
        console.log(`\nPDA verification:`);
        console.log(`  Actual PDA:  ${firstBinArray.pubkey.toBase58()}`);
        console.log(`  Derived PDA: ${derivedPda.toBase58()}`);
        console.log(`  Match: ${firstBinArray.pubkey.toBase58() === derivedPda.toBase58()}`);

        // Now fetch the pool and check bitmap
        console.log(`\nFetching pool account...`);
        const poolAccount = await connection.getAccountInfo(poolPubkey);
        if (!poolAccount) {
            console.log('Pool not found');
            return;
        }

        const poolView = new DataView(poolAccount.data.buffer, poolAccount.data.byteOffset);
        const activeId = poolView.getInt32(76, true);
        console.log(`\nPool activeId: ${activeId}`);
        console.log(`Active bin array index: ${Math.floor(activeId / BINS_PER_ARRAY)}`);

        // Decode bitmap with CURRENT interpretation
        const bitmap = new BigInt64Array(16);
        for (let i = 0; i < 16; i++) {
            bitmap[i] = poolView.getBigInt64(216 + i * 8, true);
        }

        const initializedCurrent: number[] = [];
        for (let word = 0; word < 16; word++) {
            const value = bitmap[word]!;
            if (value === 0n) continue;
            for (let bit = 0; bit < 64; bit++) {
                if ((value & (1n << BigInt(bit))) !== 0n) {
                    const flatPos = word * 64 + bit;
                    initializedCurrent.push(flatPos - 512);  // Current interpretation
                }
            }
        }

        console.log(`\nCurrent bitmap interpretation (flatPos - 512):`);
        console.log(`  Found ${initializedCurrent.length} initialized indices`);
        console.log(`  Range: ${Math.min(...initializedCurrent)} to ${Math.max(...initializedCurrent)}`);
        console.log(`  Includes bin array index ${binArrayIndex}: ${initializedCurrent.includes(binArrayIndex)}`);

        // Check alternative interpretation
        const initializedAlt: number[] = [];
        for (let word = 0; word < 16; word++) {
            const value = bitmap[word]!;
            if (value === 0n) continue;
            for (let bit = 0; bit < 64; bit++) {
                if ((value & (1n << BigInt(bit))) !== 0n) {
                    const flatPos = word * 64 + bit;
                    initializedAlt.push(flatPos);  // Alternative: no offset
                }
            }
        }

        console.log(`\nAlternative bitmap interpretation (flatPos, no offset):`);
        console.log(`  Found ${initializedAlt.length} initialized indices`);
        console.log(`  Range: ${Math.min(...initializedAlt)} to ${Math.max(...initializedAlt)}`);
        console.log(`  Includes bin array index ${binArrayIndex}: ${initializedAlt.includes(binArrayIndex)}`);

        return;
    }

    console.log(`Fetching pool ${TEST_POOL}...`);
    const poolPubkey = new PublicKey(TEST_POOL);
    const poolAccount = await connection.getAccountInfo(poolPubkey);

    if (!poolAccount) {
        console.log('Pool account not found');
        return;
    }

    const data = poolAccount.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const activeId = view.getInt32(76, true);
    console.log(`\nactiveId: ${activeId}`);
    console.log(`Active bin array index: ${Math.floor(activeId / BINS_PER_ARRAY)}`);
}

main().catch(console.error);
