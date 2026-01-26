// src/scripts/test_bin_decode.ts
// Test script for BinArray decoding using existing verified decoder

import { Connection, PublicKey } from '@solana/web3.js';
import { decodeMeteoraLbPair } from '../decoders/meteora.js';
import { binTracker } from '../ingest/binTracker.js';

// Constants
const BINS_PER_ARRAY = 70;
const BIN_SIZE_BYTES = 16;
const BIN_ARRAY_HEADER_SIZE = 24;

interface Bin {
    amountX: bigint;
    amountY: bigint;
}

interface BinArrayData {
    index: bigint;
    bins: Bin[];
}

/**
 * Converts a signed 64-bit LE buffer to bigint
 */
function readInt64LE(buffer: Buffer, offset: number): bigint {
    const low = buffer.readBigUInt64LE(offset);
    if (low >= 0x8000000000000000n) {
        return low - 0x10000000000000000n;
    }
    return low;
}

/**
 * Decodes BinArray account data
 * Layout: 8 discriminator + 8 index + 8 version = 24 header
 *         70 bins × 16 bytes = 1120 bytes
 */
function decodeBinArray(data: Buffer): BinArrayData {
    const index = readInt64LE(data, 8);
    const bins: Bin[] = [];

    for (let i = 0; i < BINS_PER_ARRAY; i++) {
        const binOffset = BIN_ARRAY_HEADER_SIZE + (i * BIN_SIZE_BYTES);

        if (binOffset + BIN_SIZE_BYTES > data.length) {
            break;
        }

        const amountX = data.readBigUInt64LE(binOffset);
        const amountY = data.readBigUInt64LE(binOffset + 8);

        bins.push({ amountX, amountY });
    }

    return { index, bins };
}

/**
 * Formats token amount for display
 */
function formatAmount(amount: bigint, decimals: number): string {
    const divisor = BigInt(10 ** decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    const fracStr = fraction.toString().padStart(decimals, '0').slice(0, 4);
    return `${whole}.${fracStr}`;
}

/**
 * Calculates offset within BinArray for a bin ID
 */
function binIdToOffsetInArray(binId: number): number {
    const offset = binId % BINS_PER_ARRAY;
    return offset >= 0 ? offset : offset + BINS_PER_ARRAY;
}

async function main() {
    const pairAddress = process.argv[2] || 'G2YJfYeBT3YXiwfMF8oyFhqYjGVDj4WLr3NKcCzpyELS';

    console.log('='.repeat(60));
    console.log('METEORA DLMM BIN ARRAY DECODER TEST');
    console.log('='.repeat(60));

    const connection = new Connection(
        'https://mainnet.helius-rpc.com/?api-key=2bb675f2-573f-4561-b57f-d351db310e5a',
        'confirmed'
    );

    const lbPair = new PublicKey(pairAddress);
    console.log(`\nLbPair: ${lbPair.toBase58()}`);

    // Step 1: Fetch LbPair account
    console.log('\n[1] Fetching LbPair account...');
    const lbPairAccount = await connection.getAccountInfo(lbPair);

    if (!lbPairAccount) {
        throw new Error('LbPair account not found');
    }

    console.log(`    Data length: ${lbPairAccount.data.length} bytes`);
    console.log(`    Owner: ${lbPairAccount.owner.toBase58()}`);

    // Step 2: Decode using YOUR verified decoder
    console.log('\n[2] Decoding LbPair with verified decoder...');
    const decoded = decodeMeteoraLbPair(lbPairAccount.data);

    console.log(`    activeId: ${decoded.activeId}`);
    console.log(`    binStep: ${decoded.binStep}`);
    console.log(`    tokenXMint: ${decoded.tokenXMint.toBase58()}`);
    console.log(`    tokenYMint: ${decoded.tokenYMint.toBase58()}`);
    console.log(`    baseFeeRate: ${(decoded.baseFeeRate * 100).toFixed(4)}%`);
    console.log(`    totalFeeRate: ${(decoded.totalFeeRate * 100).toFixed(4)}%`);

    // Step 3: Use YOUR binTracker to get PDAs
    console.log('\n[3] Deriving BinArray PDAs via binTracker...');
    const pdas = binTracker.getSubscriptionPdas(decoded.activeId, lbPair);

    console.log(`    Got ${pdas.length} BinArray PDAs:`);
    for (const { index, pda } of pdas) {
        console.log(`      index=${index}: ${pda.toBase58()}`);
    }

    // Step 4: Fetch center BinArray (the one containing activeId)
    const centerPda = pdas.find(p => {
        const arrayStart = Number(p.index) * BINS_PER_ARRAY;
        const arrayEnd = arrayStart + BINS_PER_ARRAY;
        return decoded.activeId >= arrayStart && decoded.activeId < arrayEnd;
    });

    if (!centerPda) {
        throw new Error('Could not find center BinArray PDA');
    }

    console.log(`\n[4] Fetching center BinArray: ${centerPda.pda.toBase58().slice(0, 12)}...`);
    const binArrayAccount = await connection.getAccountInfo(centerPda.pda);

    if (!binArrayAccount) {
        throw new Error('BinArray account not found');
    }

    console.log(`    Data length: ${binArrayAccount.data.length} bytes`);

    // Step 5: Decode BinArray
    console.log('\n[5] Decoding BinArray...');
    const binArrayData = decodeBinArray(binArrayAccount.data);
    console.log(`    Decoded index: ${binArrayData.index}`);
    console.log(`    Bins decoded: ${binArrayData.bins.length}`);

    // Step 6: Print active bin liquidity
    const offsetInArray = binIdToOffsetInArray(decoded.activeId);

    console.log('\n[6] Active Bin Liquidity:');
    console.log('='.repeat(60));

    const activeBin = binArrayData.bins[offsetInArray];

    if (activeBin) {
        console.log(`    Bin ID: ${decoded.activeId}`);
        console.log(`    Offset in array: ${offsetInArray}`);
        console.log(`    amountX (raw): ${activeBin.amountX}`);
        console.log(`    amountY (raw): ${activeBin.amountY}`);
        console.log(`    amountX (token): ${formatAmount(activeBin.amountX, 9)}`);
        console.log(`    amountY (SOL):   ${formatAmount(activeBin.amountY, 9)}`);
    } else {
        console.log('    ERROR: Active bin not found in array');
    }

    // Step 7: Print neighboring bins with liquidity summary
    console.log('\n[7] Neighboring Bins (-5 to +5):');
    console.log('-'.repeat(60));

    let totalX = 0n;
    let totalY = 0n;
    let binsWithLiquidity = 0;

    for (let delta = -5; delta <= 5; delta++) {
        const neighborOffset = offsetInArray + delta;
        if (neighborOffset >= 0 && neighborOffset < binArrayData.bins.length) {
            const bin = binArrayData.bins[neighborOffset];
            if (bin) {
                const binId = decoded.activeId + delta;
                const marker = delta === 0 ? ' <-- ACTIVE' : '';
                const hasLiq = bin.amountX > 0n || bin.amountY > 0n;

                if (hasLiq) {
                    binsWithLiquidity++;
                    totalX += bin.amountX;
                    totalY += bin.amountY;
                }

                console.log(
                    `    Bin ${binId.toString().padStart(6)}: ` +
                    `X=${formatAmount(bin.amountX, 9).padStart(15)} ` +
                    `Y=${formatAmount(bin.amountY, 9).padStart(15)}${marker}`
                );
            }
        }
    }

    console.log('-'.repeat(60));
    console.log(`    Bins with liquidity: ${binsWithLiquidity}/11`);
    console.log(`    Total X in range: ${formatAmount(totalX, 9)}`);
    console.log(`    Total Y in range: ${formatAmount(totalY, 9)}`);

    // Step 8: Fetch all 3 BinArrays and count total liquidity
    console.log('\n[8] Fetching all subscribed BinArrays...');

    const allBinArrays = await connection.getMultipleAccountsInfo(
        pdas.map(p => p.pda)
    );

    let grandTotalX = 0n;
    let grandTotalY = 0n;
    let totalBinsWithLiquidity = 0;

    for (let i = 0; i < allBinArrays.length; i++) {
        const account = allBinArrays[i];
        const pdaInfo = pdas[i];
        if (!account || !pdaInfo) continue;

        const arrayDecoded = decodeBinArray(account.data);
        let arrayX = 0n;
        let arrayY = 0n;
        let arrayBinsWithLiq = 0;

        for (const bin of arrayDecoded.bins) {
            if (bin.amountX > 0n || bin.amountY > 0n) {
                arrayBinsWithLiq++;
                arrayX += bin.amountX;
                arrayY += bin.amountY;
            }
        }

        grandTotalX += arrayX;
        grandTotalY += arrayY;
        totalBinsWithLiquidity += arrayBinsWithLiq;

        console.log(
            `    Array[${pdaInfo.index.toString().padStart(4)}]: ` +
            `${arrayBinsWithLiq.toString().padStart(2)} bins | ` +
            `X=${formatAmount(arrayX, 9).padStart(15)} | ` +
            `Y=${formatAmount(arrayY, 9).padStart(15)}`
        );
    }

    console.log('-'.repeat(60));
    console.log(`    TOTAL: ${totalBinsWithLiquidity} bins with liquidity`);
    console.log(`    TOTAL X: ${formatAmount(grandTotalX, 9)}`);
    console.log(`    TOTAL Y: ${formatAmount(grandTotalY, 9)}`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ DECODE COMPLETE - Your decoder and binTracker are working');
    console.log('='.repeat(60));
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});