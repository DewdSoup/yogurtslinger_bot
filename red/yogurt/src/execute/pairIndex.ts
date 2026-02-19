import bs58 from 'bs58';
import { PoolLifecycleState, type LifecycleRegistry } from '../cache/lifecycle.js';
import type { MeteoraDlmmPool, PoolState, PumpSwapPool } from '../types.js';
import { VenueId } from '../types.js';

const WSOL_MINT = new Uint8Array(bs58.decode('So11111111111111111111111111111111111111112'));

function toHex(buf: Uint8Array): string {
    let out = '';
    for (let i = 0; i < buf.length; i++) out += buf[i]!.toString(16).padStart(2, '0');
    return out;
}

function fromHex(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, 'hex'));
}

function normalizePair(aHex: string, bHex: string): string {
    return aHex < bHex ? `${aHex}|${bHex}` : `${bHex}|${aHex}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function isWsolMint(mint: Uint8Array): boolean {
    return bytesEqual(mint, WSOL_MINT);
}

export interface CounterpartResult {
    pairKey: string;
    poolPubkeys: Uint8Array[];
}

export interface PairIndexConfig {
    includeTopologyFrozen?: boolean;
}

interface PairEntry {
    pairKey: string;
    pumpswapPools: Set<string>;
    dlmmPools: Set<string>;
}

interface PoolRef {
    venue: VenueId;
    pairKey: string;
    poolHex: string;
    slot: number;
}

function getPairKey(pool: PoolState): string | null {
    if (pool.venue === VenueId.PumpSwap) {
        const p = pool as PumpSwapPool;
        if (!isWsolMint(p.baseMint) && !isWsolMint(p.quoteMint)) return null;
        return normalizePair(toHex(p.baseMint), toHex(p.quoteMint));
    }

    if (pool.venue === VenueId.MeteoraDlmm) {
        const p = pool as MeteoraDlmmPool;
        if (!isWsolMint(p.tokenXMint) && !isWsolMint(p.tokenYMint)) return null;
        return normalizePair(toHex(p.tokenXMint), toHex(p.tokenYMint));
    }

    return null;
}

/**
 * O(1) pool counterpart lookup for cross-venue PS<->DLMM routing.
 */
export class PairIndex {
    private readonly pairs = new Map<string, PairEntry>();
    private readonly pools = new Map<string, PoolRef>();
    private readonly includeTopologyFrozen: boolean;

    constructor(
        private readonly lifecycle?: LifecycleRegistry,
        config?: PairIndexConfig,
    ) {
        this.includeTopologyFrozen = config?.includeTopologyFrozen ?? false;
    }

    private isPoolEligible(poolPubkey: Uint8Array): boolean {
        if (!this.lifecycle) return true;
        const state = this.lifecycle.getState(poolPubkey);
        if (state === PoolLifecycleState.ACTIVE) return true;
        if (this.includeTopologyFrozen && state === PoolLifecycleState.TOPOLOGY_FROZEN) return true;
        return false;
    }

    upsertPool(poolPubkey: Uint8Array, pool: PoolState, slot: number): void {
        const poolHex = toHex(poolPubkey);

        // Remove old mapping if venue no longer tracked.
        if (pool.venue !== VenueId.PumpSwap && pool.venue !== VenueId.MeteoraDlmm) {
            this.removePool(poolHex);
            return;
        }

        if (!this.isPoolEligible(poolPubkey)) {
            this.removePool(poolHex);
            return;
        }

        const pairKey = getPairKey(pool);
        if (!pairKey) {
            this.removePool(poolHex);
            return;
        }

        const existing = this.pools.get(poolHex);
        if (existing && existing.pairKey !== pairKey) {
            this.removePool(poolHex);
        }

        let pair = this.pairs.get(pairKey);
        if (!pair) {
            pair = {
                pairKey,
                pumpswapPools: new Set<string>(),
                dlmmPools: new Set<string>(),
            };
            this.pairs.set(pairKey, pair);
        }

        if (pool.venue === VenueId.PumpSwap) {
            pair.pumpswapPools.add(poolHex);
            pair.dlmmPools.delete(poolHex);
        } else {
            pair.dlmmPools.add(poolHex);
            pair.pumpswapPools.delete(poolHex);
        }

        this.pools.set(poolHex, {
            venue: pool.venue,
            pairKey,
            poolHex,
            slot,
        });
    }

    removePool(poolHex: string): void {
        const existing = this.pools.get(poolHex);
        if (!existing) return;

        const pair = this.pairs.get(existing.pairKey);
        if (pair) {
            pair.pumpswapPools.delete(poolHex);
            pair.dlmmPools.delete(poolHex);
            if (pair.pumpswapPools.size === 0 && pair.dlmmPools.size === 0) {
                this.pairs.delete(existing.pairKey);
            }
        }

        this.pools.delete(poolHex);
    }

    getPairKeyForPool(poolPubkey: Uint8Array): string | null {
        return this.pools.get(toHex(poolPubkey))?.pairKey ?? null;
    }

    getCounterpartPools(pairKey: string, venue: VenueId): Uint8Array[] {
        const pair = this.pairs.get(pairKey);
        if (!pair) return [];

        if (venue === VenueId.PumpSwap) {
            return [...pair.dlmmPools].map(fromHex);
        }

        if (venue === VenueId.MeteoraDlmm) {
            return [...pair.pumpswapPools].map(fromHex);
        }

        return [];
    }

    getCounterpartsForPool(poolPubkey: Uint8Array, venue: VenueId): CounterpartResult | null {
        const pairKey = this.getPairKeyForPool(poolPubkey);
        if (!pairKey) return null;
        return {
            pairKey,
            poolPubkeys: this.getCounterpartPools(pairKey, venue),
        };
    }

    stats(): { trackedPairs: number; trackedPools: number } {
        return {
            trackedPairs: this.pairs.size,
            trackedPools: this.pools.size,
        };
    }
}

export const INTERNAL = {
    WSOL_MINT,
    isWsolMint,
    normalizePair,
};
