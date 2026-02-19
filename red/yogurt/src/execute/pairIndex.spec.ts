import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';

import { PairIndex } from './pairIndex.js';
import { VenueId } from '../types.js';
import type { MeteoraDlmmPool, PumpSwapPool } from '../types.js';

const ZERO32 = new Uint8Array(32);
const WSOL = new Uint8Array(bs58.decode('So11111111111111111111111111111111111111112'));

function mint(seed: number): Uint8Array {
    const out = new Uint8Array(32);
    out[0] = seed;
    return out;
}

function pool(seed: number): Uint8Array {
    const out = new Uint8Array(32);
    out[31] = seed;
    return out;
}

test('PairIndex tracks PumpSwap<->DLMM counterparts on WSOL pairs', () => {
    const token = mint(7);
    const psPoolPubkey = pool(1);
    const dlmmPoolPubkey = pool(2);

    const psPool: PumpSwapPool = {
        venue: VenueId.PumpSwap,
        pool: psPoolPubkey,
        baseMint: token,
        quoteMint: WSOL,
        baseVault: ZERO32,
        quoteVault: ZERO32,
        lpMint: ZERO32,
        lpSupply: 0n,
    };

    const dlmmPool: MeteoraDlmmPool = {
        venue: VenueId.MeteoraDlmm,
        pool: dlmmPoolPubkey,
        tokenXMint: token,
        tokenYMint: WSOL,
        vaultX: ZERO32,
        vaultY: ZERO32,
        binStep: 10,
        activeId: 0,
        baseFactor: 0n,
        protocolShare: 0n,
        volatilityAccumulator: 0,
        volatilityReference: 0,
        status: 0,
        binArrayBitmap: new BigInt64Array(16),
    };

    const idx = new PairIndex();
    idx.upsertPool(psPoolPubkey, psPool, 100);
    idx.upsertPool(dlmmPoolPubkey, dlmmPool, 100);

    const pairKey = idx.getPairKeyForPool(psPoolPubkey);
    assert.ok(pairKey);

    const counterparts = idx.getCounterpartPools(pairKey!, VenueId.PumpSwap);
    assert.equal(counterparts.length, 1);
    assert.deepEqual(counterparts[0], dlmmPoolPubkey);
});

test('PairIndex ignores non-WSOL pairs', () => {
    const idx = new PairIndex();

    const psPool: PumpSwapPool = {
        venue: VenueId.PumpSwap,
        pool: pool(3),
        baseMint: mint(11),
        quoteMint: mint(12),
        baseVault: ZERO32,
        quoteVault: ZERO32,
        lpMint: ZERO32,
        lpSupply: 0n,
    };

    idx.upsertPool(psPool.pool, psPool, 10);
    assert.equal(idx.stats().trackedPairs, 0);
    assert.equal(idx.stats().trackedPools, 0);
});
