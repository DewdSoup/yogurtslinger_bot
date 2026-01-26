import test from 'node:test';
import assert from 'node:assert/strict';

import { getAmountOut, simulateConstantProduct } from './constantProduct.js';
import { SwapDirection, VenueId, type PoolState, type PumpSwapPool } from '../../types.js';

const ZERO32 = new Uint8Array(32);

/**
 * PumpSwapPool has several runtime-injected optional fields (reserves + fees).
 * For constant-product math tests we require those fields to be present.
 */
type PumpSwapPoolReady = PumpSwapPool & {
    baseReserve: bigint;
    quoteReserve: bigint;
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
};

function makePumpSwapPool(overrides: Partial<PumpSwapPoolReady> = {}): PumpSwapPoolReady {
    const base: PumpSwapPoolReady = {
        venue: VenueId.PumpSwap,
        pool: ZERO32,
        baseMint: ZERO32,
        quoteMint: ZERO32,
        baseVault: ZERO32,
        quoteVault: ZERO32,
        lpMint: ZERO32,
        lpSupply: 0n,
        baseReserve: 1_000_000n,
        quoteReserve: 2_000_000n,
        lpFeeBps: 20n,
        protocolFeeBps: 5n,
    };
    return { ...base, ...overrides };
}

function assertPumpSwapReady(p: PoolState): asserts p is PumpSwapPoolReady {
    assert.equal(p.venue, VenueId.PumpSwap);
    const ps = p as PumpSwapPool;
    assert.ok(ps.baseReserve !== undefined);
    assert.ok(ps.quoteReserve !== undefined);
    assert.ok(ps.lpFeeBps !== undefined);
    assert.ok(ps.protocolFeeBps !== undefined);
}

test('constantProduct: output is deterministic and state updates match implementation', () => {
    const pool = makePumpSwapPool({
        baseReserve: 1_000_000n,
        quoteReserve: 1_000_000n,
        lpFeeBps: 20n,
        protocolFeeBps: 5n,
    });

    const inputAmount = 100_000n;

    const r = simulateConstantProduct({
        venue: VenueId.PumpSwap,
        pool: pool.pool,
        direction: SwapDirection.AtoB,
        inputAmount,
        poolState: pool,
    });

    assert.equal(r.success, true);
    assert.ok(r.outputAmount > 0n);
    assert.ok(r.outputAmount < pool.quoteReserve);

    // Validate new-state bookkeeping matches implementation:
    // - feePaid = floor(amountIn * feeBps / 10000)
    // - reserveIn increases by amountAfterFee (current impl)
    const feeBps = pool.lpFeeBps + pool.protocolFeeBps;
    const feePaid = (inputAmount * feeBps) / 10000n;
    const amountAfterFee = inputAmount - feePaid;

    assertPumpSwapReady(r.newPoolState);
    assert.equal(r.feePaid, feePaid);
    assert.equal(r.newPoolState.baseReserve, pool.baseReserve + amountAfterFee);
    assert.equal(r.newPoolState.quoteReserve, pool.quoteReserve - r.outputAmount);
});

test('constantProduct: matches canonical input-fee formula used internally', () => {
    const pool = makePumpSwapPool({
        baseReserve: 3_000_000n,
        quoteReserve: 9_000_000n,
        lpFeeBps: 20n,
        protocolFeeBps: 5n,
    });

    const inputAmount = 555_555n;
    const feeBps = pool.lpFeeBps + pool.protocolFeeBps;

    // Independent re-derivation of the fee-integrated output formula:
    // out = (y * dx*(10000-fee)) / (x*10000 + dx*(10000-fee))
    const amountInWithFee = inputAmount * (10000n - feeBps);
    const expectedOut = (pool.quoteReserve * amountInWithFee) / (pool.baseReserve * 10000n + amountInWithFee);

    const r = simulateConstantProduct({
        venue: VenueId.PumpSwap,
        pool: pool.pool,
        direction: SwapDirection.AtoB,
        inputAmount,
        poolState: pool,
    });

    assert.equal(r.success, true);
    assert.equal(r.outputAmount, expectedOut);

    // Also matches exported helper (should be equivalent to expectedOut above)
    assert.equal(getAmountOut(inputAmount, pool.baseReserve, pool.quoteReserve, feeBps), expectedOut);
});
