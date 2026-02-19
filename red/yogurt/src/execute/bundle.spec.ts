import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

import { buildMeteoraDlmmSwapIx } from './bundle.js';
import { SwapDirection, VenueId, type MeteoraDlmmPool } from '../types.js';

const WSOL = new Uint8Array(bs58.decode('So11111111111111111111111111111111111111112'));

function seed32(seed: number): Uint8Array {
    const out = new Uint8Array(32);
    out[0] = seed;
    return out;
}

test('buildMeteoraDlmmSwapIx keeps expected core account order', () => {
    const pool: MeteoraDlmmPool = {
        venue: VenueId.MeteoraDlmm,
        pool: seed32(1),
        tokenXMint: seed32(2),
        tokenYMint: WSOL,
        vaultX: seed32(3),
        vaultY: seed32(4),
        oracle: seed32(5),
        binStep: 10,
        activeId: 0,
        baseFactor: 0n,
        protocolShare: 0n,
        volatilityAccumulator: 0,
        volatilityReference: 0,
        status: 0,
        binArrayBitmap: new BigInt64Array(16),
    };

    const payer = Keypair.generate();
    const ix = buildMeteoraDlmmSwapIx(payer.publicKey, {
        pool,
        direction: SwapDirection.BtoA,
        inputAmount: 1_000_000n,
        minOutput: 1n,
        dlmm: {
            binArrays: [seed32(9), seed32(10)],
        },
    });

    // 15 core accounts + 2 bin arrays
    assert.equal(ix.keys.length, 17);

    // Core ordering checks
    assert.deepEqual(ix.keys[0]!.pubkey.toBytes(), pool.pool);        // lbPair
    assert.deepEqual(ix.keys[2]!.pubkey.toBytes(), pool.vaultX);      // reserveX
    assert.deepEqual(ix.keys[3]!.pubkey.toBytes(), pool.vaultY);      // reserveY
    assert.deepEqual(ix.keys[6]!.pubkey.toBytes(), pool.tokenXMint);  // tokenXMint
    assert.deepEqual(ix.keys[7]!.pubkey.toBytes(), pool.tokenYMint);  // tokenYMint
    assert.deepEqual(ix.keys[8]!.pubkey.toBytes(), pool.oracle!);      // oracle

    // Trailing bin arrays
    assert.deepEqual(ix.keys[15]!.pubkey.toBytes(), seed32(9));
    assert.deepEqual(ix.keys[16]!.pubkey.toBytes(), seed32(10));
});
