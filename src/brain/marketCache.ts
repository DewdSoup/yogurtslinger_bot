// src/brain/marketCache.ts
// Enhanced with pool creation tracking, initial sync detection, and CLMM support
// CRITICAL: No latency impact - all tracking is metadata only
//
// FIX v2 (Dec 2024):
// - Added isMemecoin() filter to getPumpSwapSolTokenPools() and getMeteoraSolTokenPools()
// - CRITICAL: Use isSolMint() function instead of direct comparison to solMintStr
//   to handle both wrapped SOL and native SOL mint addresses

import type { PumpBondingCurveState } from "../decoders/pump.js";
import type { RaydiumPoolState, RaydiumCLMMPool } from "../decoders/raydium.js";
import type { PumpSwapPoolState } from "../decoders/pumpswap.js";
import type { MeteoraLbPairState } from "../decoders/meteora.js";
import { TokenAccountCache } from "./tokenAccountCache.js";

// Track initial sync state globally
let initialSyncComplete = false;
let initialSyncStartTs = Date.now();
const INITIAL_SYNC_WINDOW_MS = 15000; // 15 seconds for initial burst

export function markInitialSyncComplete(): void {
    initialSyncComplete = true;
    console.log(`[marketCache] Initial sync complete after ${Date.now() - initialSyncStartTs}ms`);
}

export function isInitialSyncComplete(): boolean {
    // Auto-complete after window expires
    if (!initialSyncComplete && Date.now() - initialSyncStartTs > INITIAL_SYNC_WINDOW_MS) {
        markInitialSyncComplete();
    }
    return initialSyncComplete;
}

export function resetInitialSyncState(): void {
    initialSyncComplete = false;
    initialSyncStartTs = Date.now();
}

export interface PumpCurveEntry {
    pubkey: string;
    slot: bigint;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: bigint | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    state: PumpBondingCurveState;
}

export interface RaydiumPoolEntry {
    pubkey: string;
    slot: bigint;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: bigint | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    state: RaydiumPoolState;
}

// ✅ Raydium CLMM Pool Entry
export interface RaydiumCLMMPoolEntry {
    pubkey: string;
    slot: bigint;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: bigint | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    state: RaydiumCLMMPool;
}

export interface PumpSwapPoolEntry {
    pubkey: string;
    slot: bigint;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: bigint | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    state: PumpSwapPoolState;
}

export interface MeteoraPoolEntry {
    pubkey: string;
    slot: bigint;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: bigint | null;
    createdTs: number | null;
    detectedDuringSync: boolean;
    state: MeteoraLbPairState;
}

const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const NATIVE_SOL_MINT_STR = "11111111111111111111111111111111";
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT_STR = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

// ✅ FIX: Check both wrapped SOL and native SOL
function isSolMint(mint: string): boolean {
    return mint === SOL_MINT_STR || mint === NATIVE_SOL_MINT_STR;
}

function isStablecoin(mint: string): boolean {
    return mint === USDC_MINT_STR || mint === USDT_MINT_STR;
}

function isMemecoin(mint: string): boolean {
    return !isSolMint(mint) && !isStablecoin(mint);
}

// Callback type for account update notifications
type AccountUpdateCallback = (pubkey: string, slot: number) => void;

export class MarketCache {
    private readonly pumpCurves = new Map<string, PumpCurveEntry>();
    private readonly raydiumPools = new Map<string, RaydiumPoolEntry>();
    private readonly raydiumCLMMPools = new Map<string, RaydiumCLMMPoolEntry>();
    private readonly pumpSwapPools = new Map<string, PumpSwapPoolEntry>();
    private readonly meteoraPools = new Map<string, MeteoraPoolEntry>();
    private readonly tokenAccounts: TokenAccountCache;

    // Subscriber list for event-driven notifications
    private readonly subscribers: AccountUpdateCallback[] = [];

    // Track the highest slot we've seen for time estimation
    private highestSlot: bigint = 0n;

    constructor() {
        this.tokenAccounts = new TokenAccountCache();
    }

    /**
     * Subscribe to market account updates.
     * Callback is invoked whenever a pool account is upserted.
     */
    public subscribeToUpdates(callback: AccountUpdateCallback): void {
        this.subscribers.push(callback);
    }

    /**
     * Notify all subscribers of an account update.
     * Called after each pool upsert.
     */
    private notifySubscribers(pubkey: string, slot: bigint): void {
        const slotNum = Number(slot);
        for (const callback of this.subscribers) {
            callback(pubkey, slotNum);
        }
    }

    getTokenAccountCache(): TokenAccountCache {
        return this.tokenAccounts;
    }

    getHighestSlot(): bigint {
        return this.highestSlot;
    }

    private updateHighestSlot(slot: bigint): void {
        if (slot > this.highestSlot) {
            this.highestSlot = slot;
        }
    }

    // ---- Pump curves ----
    upsertPumpCurve(
        pubkey: string,
        slot: number | bigint,
        state: PumpBondingCurveState
    ): void {
        const normalizedSlot = typeof slot === "bigint" ? slot : BigInt(slot);
        this.updateHighestSlot(normalizedSlot);

        const existing = this.pumpCurves.get(pubkey);
        const now = Date.now();
        const duringSync = !isInitialSyncComplete();

        let createdSlot: bigint | null = null;
        let createdTs: number | null = null;

        if (!existing) {
            if (duringSync) {
                createdSlot = null;
                createdTs = null;
            } else {
                createdSlot = normalizedSlot;
                createdTs = now;
            }
        } else {
            createdSlot = existing.createdSlot;
            createdTs = existing.createdTs;
        }

        const entry: PumpCurveEntry = {
            pubkey,
            slot: normalizedSlot,
            firstSeenTs: existing?.firstSeenTs ?? now,
            lastUpdatedTs: now,
            createdSlot,
            createdTs,
            detectedDuringSync: existing?.detectedDuringSync ?? duringSync,
            state
        };
        this.pumpCurves.set(pubkey, entry);
        this.notifySubscribers(pubkey, normalizedSlot);
    }

    getPumpCount(): number {
        return this.pumpCurves.size;
    }

    getSamplePumpCurves(limit = 3): PumpCurveEntry[] {
        return Array.from(this.pumpCurves.values()).slice(0, limit);
    }

    getPumpCurve(pubkey: string): PumpCurveEntry | undefined {
        return this.pumpCurves.get(pubkey);
    }

    getAllPumpCurves(): PumpCurveEntry[] {
        return Array.from(this.pumpCurves.values());
    }

    // ---- Raydium V4 pools ----
    upsertRaydiumPool(
        pubkey: string,
        slot: number | bigint,
        state: RaydiumPoolState
    ): void {
        const normalizedSlot = typeof slot === "bigint" ? slot : BigInt(slot);
        this.updateHighestSlot(normalizedSlot);

        const existing = this.raydiumPools.get(pubkey);
        const now = Date.now();
        const duringSync = !isInitialSyncComplete();

        let createdSlot: bigint | null = null;
        let createdTs: number | null = null;

        if (!existing) {
            if (duringSync) {
                createdSlot = null;
                createdTs = null;
            } else {
                createdSlot = normalizedSlot;
                createdTs = now;
            }
        } else {
            createdSlot = existing.createdSlot;
            createdTs = existing.createdTs;
        }

        const entry: RaydiumPoolEntry = {
            pubkey,
            slot: normalizedSlot,
            firstSeenTs: existing?.firstSeenTs ?? now,
            lastUpdatedTs: now,
            createdSlot,
            createdTs,
            detectedDuringSync: existing?.detectedDuringSync ?? duringSync,
            state
        };
        this.raydiumPools.set(pubkey, entry);
        this.notifySubscribers(pubkey, normalizedSlot);
    }

    getRaydiumCount(): number {
        return this.raydiumPools.size;
    }

    getSampleRaydiumPools(limit = 3): RaydiumPoolEntry[] {
        return Array.from(this.raydiumPools.values()).slice(0, limit);
    }

    getRaydiumPool(pubkey: string): RaydiumPoolEntry | undefined {
        return this.raydiumPools.get(pubkey);
    }

    getAllRaydiumPools(): RaydiumPoolEntry[] {
        return Array.from(this.raydiumPools.values());
    }

    // ---- Raydium CLMM pools ----
    upsertRaydiumCLMMPool(
        pubkey: string,
        slot: number | bigint,
        state: RaydiumCLMMPool
    ): void {
        const normalizedSlot = typeof slot === "bigint" ? slot : BigInt(slot);
        this.updateHighestSlot(normalizedSlot);

        const existing = this.raydiumCLMMPools.get(pubkey);
        const now = Date.now();
        const duringSync = !isInitialSyncComplete();

        let createdSlot: bigint | null = null;
        let createdTs: number | null = null;

        if (!existing) {
            if (duringSync) {
                createdSlot = null;
                createdTs = null;
            } else {
                createdSlot = normalizedSlot;
                createdTs = now;
            }
        } else {
            createdSlot = existing.createdSlot;
            createdTs = existing.createdTs;
        }

        const entry: RaydiumCLMMPoolEntry = {
            pubkey,
            slot: normalizedSlot,
            firstSeenTs: existing?.firstSeenTs ?? now,
            lastUpdatedTs: now,
            createdSlot,
            createdTs,
            detectedDuringSync: existing?.detectedDuringSync ?? duringSync,
            state
        };
        this.raydiumCLMMPools.set(pubkey, entry);
        this.notifySubscribers(pubkey, normalizedSlot);
    }

    getRaydiumCLMMCount(): number {
        return this.raydiumCLMMPools.size;
    }

    getSampleRaydiumCLMMPools(limit = 3): RaydiumCLMMPoolEntry[] {
        return Array.from(this.raydiumCLMMPools.values()).slice(0, limit);
    }

    getRaydiumCLMMPool(pubkey: string): RaydiumCLMMPoolEntry | undefined {
        return this.raydiumCLMMPools.get(pubkey);
    }

    getAllRaydiumCLMMPools(): RaydiumCLMMPoolEntry[] {
        return Array.from(this.raydiumCLMMPools.values());
    }

    /**
     * Get Raydium CLMM pools paired with SOL and a memecoin.
     * 
     * ✅ FIX: Uses isSolMint() to check both wrapped and native SOL
     */
    getRaydiumCLMMSolTokenPools(_solMintStr: string = SOL_MINT_STR): Array<{
        entry: RaydiumCLMMPoolEntry;
        tokenMint: string;
        solIs0: boolean;
    }> {
        const results: Array<{
            entry: RaydiumCLMMPoolEntry;
            tokenMint: string;
            solIs0: boolean;
        }> = [];

        for (const entry of this.raydiumCLMMPools.values()) {
            const mint0 = entry.state.tokenMint0.toBase58();
            const mint1 = entry.state.tokenMint1.toBase58();

            // ✅ FIX: Use isSolMint() instead of direct comparison
            if (isSolMint(mint0) && isMemecoin(mint1)) {
                results.push({
                    entry,
                    tokenMint: mint1,
                    solIs0: true
                });
            } else if (isSolMint(mint1) && isMemecoin(mint0)) {
                results.push({
                    entry,
                    tokenMint: mint0,
                    solIs0: false
                });
            }
        }

        return results;
    }

    // ---- PumpSwap pools ----
    upsertPumpSwapPool(
        pubkey: string,
        slot: number | bigint,
        state: PumpSwapPoolState
    ): void {
        const normalizedSlot = typeof slot === "bigint" ? slot : BigInt(slot);
        this.updateHighestSlot(normalizedSlot);

        const existing = this.pumpSwapPools.get(pubkey);
        const now = Date.now();
        const duringSync = !isInitialSyncComplete();

        let createdSlot: bigint | null = null;
        let createdTs: number | null = null;

        if (!existing) {
            if (duringSync) {
                createdSlot = null;
                createdTs = null;
            } else {
                createdSlot = normalizedSlot;
                createdTs = now;
            }
        } else {
            createdSlot = existing.createdSlot;
            createdTs = existing.createdTs;
        }

        const entry: PumpSwapPoolEntry = {
            pubkey,
            slot: normalizedSlot,
            firstSeenTs: existing?.firstSeenTs ?? now,
            lastUpdatedTs: now,
            createdSlot,
            createdTs,
            detectedDuringSync: existing?.detectedDuringSync ?? duringSync,
            state
        };
        this.pumpSwapPools.set(pubkey, entry);
        this.notifySubscribers(pubkey, normalizedSlot);
    }

    getPumpSwapCount(): number {
        return this.pumpSwapPools.size;
    }

    getSamplePumpSwapPools(limit = 3): PumpSwapPoolEntry[] {
        return Array.from(this.pumpSwapPools.values()).slice(0, limit);
    }

    getPumpSwapPool(pubkey: string): PumpSwapPoolEntry | undefined {
        return this.pumpSwapPools.get(pubkey);
    }

    getAllPumpSwapPools(): PumpSwapPoolEntry[] {
        return Array.from(this.pumpSwapPools.values());
    }

    /**
     * Get PumpSwap pools paired with SOL and a memecoin.
     * 
     * ✅ FIX v2: 
     * - Uses isSolMint() to check BOTH wrapped SOL and native SOL
     * - Added isMemecoin() filter to exclude stablecoins (USDC/USDT)
     */
    getPumpSwapSolTokenPools(_solMintStr: string = SOL_MINT_STR): Array<{
        entry: PumpSwapPoolEntry;
        tokenMint: string;
        solIsBase: boolean;
    }> {
        const results: Array<{
            entry: PumpSwapPoolEntry;
            tokenMint: string;
            solIsBase: boolean;
        }> = [];

        for (const entry of this.pumpSwapPools.values()) {
            const baseMint = entry.state.baseMint.toBase58();
            const quoteMint = entry.state.quoteMint.toBase58();

            // ✅ FIX: Use isSolMint() instead of direct comparison + isMemecoin() filter
            if (isSolMint(baseMint) && isMemecoin(quoteMint)) {
                results.push({
                    entry,
                    tokenMint: quoteMint,
                    solIsBase: true
                });
            } else if (isSolMint(quoteMint) && isMemecoin(baseMint)) {
                results.push({
                    entry,
                    tokenMint: baseMint,
                    solIsBase: false
                });
            }
        }

        return results;
    }

    // ---- Meteora DLMM pools ----
    upsertMeteoraPool(
        pubkey: string,
        slot: number | bigint,
        state: MeteoraLbPairState
    ): void {
        const normalizedSlot = typeof slot === "bigint" ? slot : BigInt(slot);
        this.updateHighestSlot(normalizedSlot);

        const existing = this.meteoraPools.get(pubkey);
        const now = Date.now();
        const duringSync = !isInitialSyncComplete();

        let createdSlot: bigint | null = null;
        let createdTs: number | null = null;

        if (!existing) {
            if (duringSync) {
                createdSlot = null;
                createdTs = null;
            } else {
                createdSlot = normalizedSlot;
                createdTs = now;
            }
        } else {
            createdSlot = existing.createdSlot;
            createdTs = existing.createdTs;
        }

        const entry: MeteoraPoolEntry = {
            pubkey,
            slot: normalizedSlot,
            firstSeenTs: existing?.firstSeenTs ?? now,
            lastUpdatedTs: now,
            createdSlot,
            createdTs,
            detectedDuringSync: existing?.detectedDuringSync ?? duringSync,
            state
        };
        this.meteoraPools.set(pubkey, entry);
        this.notifySubscribers(pubkey, normalizedSlot);
    }

    getMeteoraCount(): number {
        return this.meteoraPools.size;
    }

    getSampleMeteoraPools(limit = 3): MeteoraPoolEntry[] {
        return Array.from(this.meteoraPools.values()).slice(0, limit);
    }

    getMeteoraPool(pubkey: string): MeteoraPoolEntry | undefined {
        return this.meteoraPools.get(pubkey);
    }

    getAllMeteoraPools(): MeteoraPoolEntry[] {
        return Array.from(this.meteoraPools.values());
    }

    /**
     * Get Meteora pools paired with SOL and a memecoin.
     * 
     * ✅ FIX v2:
     * - Uses isSolMint() to check BOTH wrapped SOL and native SOL
     * - Added isMemecoin() filter to exclude stablecoins (USDC/USDT)
     */
    getMeteoraSolTokenPools(_solMintStr: string = SOL_MINT_STR): Array<{
        entry: MeteoraPoolEntry;
        tokenMint: string;
        solIsX: boolean;
    }> {
        const results: Array<{
            entry: MeteoraPoolEntry;
            tokenMint: string;
            solIsX: boolean;
        }> = [];

        for (const entry of this.meteoraPools.values()) {
            const tokenXMint = entry.state.tokenXMint.toBase58();
            const tokenYMint = entry.state.tokenYMint.toBase58();

            // ✅ FIX: Use isSolMint() instead of direct comparison + isMemecoin() filter
            if (isSolMint(tokenXMint) && isMemecoin(tokenYMint)) {
                results.push({
                    entry,
                    tokenMint: tokenYMint,
                    solIsX: true
                });
            } else if (isSolMint(tokenYMint) && isMemecoin(tokenXMint)) {
                results.push({
                    entry,
                    tokenMint: tokenXMint,
                    solIsX: false
                });
            }
        }

        return results;
    }

    // ---- Cross-venue helpers ----
    // ✅ Includes Raydium CLMM
    getFragmentedTokens(solMintStr: string = SOL_MINT_STR): Map<string, {
        pumpSwap?: PumpSwapPoolEntry;
        raydiumV4?: RaydiumPoolEntry;
        raydiumClmm?: RaydiumCLMMPoolEntry;
        meteora?: MeteoraPoolEntry;
    }> {
        const tokenVenues = new Map<string, {
            pumpSwap?: PumpSwapPoolEntry;
            raydiumV4?: RaydiumPoolEntry;
            raydiumClmm?: RaydiumCLMMPoolEntry;
            meteora?: MeteoraPoolEntry;
        }>();

        // PumpSwap - now correctly filtered by isSolMint() and isMemecoin()
        for (const { entry, tokenMint } of this.getPumpSwapSolTokenPools(solMintStr)) {
            if (!tokenVenues.has(tokenMint)) {
                tokenVenues.set(tokenMint, {});
            }
            tokenVenues.get(tokenMint)!.pumpSwap = entry;
        }

        // Raydium V4 - using isSolMint() and isMemecoin()
        for (const entry of this.raydiumPools.values()) {
            const baseMint = entry.state.baseMint.toBase58();
            const quoteMint = entry.state.quoteMint.toBase58();

            let tokenMint: string | null = null;
            if (isSolMint(baseMint) && isMemecoin(quoteMint)) {
                tokenMint = quoteMint;
            } else if (isSolMint(quoteMint) && isMemecoin(baseMint)) {
                tokenMint = baseMint;
            }

            if (tokenMint) {
                if (!tokenVenues.has(tokenMint)) {
                    tokenVenues.set(tokenMint, {});
                }
                tokenVenues.get(tokenMint)!.raydiumV4 = entry;
            }
        }

        // Raydium CLMM - already uses isSolMint() and isMemecoin()
        for (const { entry, tokenMint } of this.getRaydiumCLMMSolTokenPools(solMintStr)) {
            if (!tokenVenues.has(tokenMint)) {
                tokenVenues.set(tokenMint, {});
            }
            tokenVenues.get(tokenMint)!.raydiumClmm = entry;
        }

        // Meteora - now correctly filtered by isSolMint() and isMemecoin()
        for (const { entry, tokenMint } of this.getMeteoraSolTokenPools(solMintStr)) {
            if (!tokenVenues.has(tokenMint)) {
                tokenVenues.set(tokenMint, {});
            }
            tokenVenues.get(tokenMint)!.meteora = entry;
        }

        // Filter to only tokens with 2+ venues
        const fragmented = new Map<string, {
            pumpSwap?: PumpSwapPoolEntry;
            raydiumV4?: RaydiumPoolEntry;
            raydiumClmm?: RaydiumCLMMPoolEntry;
            meteora?: MeteoraPoolEntry;
        }>();

        for (const [mint, venues] of tokenVenues) {
            const venueCount = (venues.pumpSwap ? 1 : 0) +
                (venues.raydiumV4 ? 1 : 0) +
                (venues.raydiumClmm ? 1 : 0) +
                (venues.meteora ? 1 : 0);
            if (venueCount >= 2) {
                fragmented.set(mint, venues);
            }
        }

        return fragmented;
    }

    /**
     * Get newly created pools (detected after initial sync)
     * These are the high-priority opportunities
     */
    getNewlyCreatedPools(): {
        pumpSwap: PumpSwapPoolEntry[];
        raydiumV4: RaydiumPoolEntry[];
        raydiumClmm: RaydiumCLMMPoolEntry[];
        meteora: MeteoraPoolEntry[];
    } {
        return {
            pumpSwap: Array.from(this.pumpSwapPools.values()).filter(p => !p.detectedDuringSync),
            raydiumV4: Array.from(this.raydiumPools.values()).filter(p => !p.detectedDuringSync),
            raydiumClmm: Array.from(this.raydiumCLMMPools.values()).filter(p => !p.detectedDuringSync),
            meteora: Array.from(this.meteoraPools.values()).filter(p => !p.detectedDuringSync)
        };
    }

    /**
     * Get pools created in the last N milliseconds
     */
    getRecentlyCreatedPools(maxAgeMs: number): {
        pumpSwap: PumpSwapPoolEntry[];
        raydiumV4: RaydiumPoolEntry[];
        raydiumClmm: RaydiumCLMMPoolEntry[];
        meteora: MeteoraPoolEntry[];
    } {
        const now = Date.now();
        const cutoff = now - maxAgeMs;

        return {
            pumpSwap: Array.from(this.pumpSwapPools.values())
                .filter(p => p.createdTs !== null && p.createdTs >= cutoff),
            raydiumV4: Array.from(this.raydiumPools.values())
                .filter(p => p.createdTs !== null && p.createdTs >= cutoff),
            raydiumClmm: Array.from(this.raydiumCLMMPools.values())
                .filter(p => p.createdTs !== null && p.createdTs >= cutoff),
            meteora: Array.from(this.meteoraPools.values())
                .filter(p => p.createdTs !== null && p.createdTs >= cutoff)
        };
    }

    getSummary(): {
        pumpCurves: number;
        raydiumV4Pools: number;
        raydiumClmmPools: number;
        pumpSwapPools: number;
        meteoraPools: number;
        fragmentedTokens: number;
        newPoolsCount: number;
        initialSyncComplete: boolean;
        highestSlot: string;
    } {
        const newPools = this.getNewlyCreatedPools();
        const newCount = newPools.pumpSwap.length + newPools.raydiumV4.length +
            newPools.raydiumClmm.length + newPools.meteora.length;

        return {
            pumpCurves: this.pumpCurves.size,
            raydiumV4Pools: this.raydiumPools.size,
            raydiumClmmPools: this.raydiumCLMMPools.size,
            pumpSwapPools: this.pumpSwapPools.size,
            meteoraPools: this.meteoraPools.size,
            fragmentedTokens: this.getFragmentedTokens().size,
            newPoolsCount: newCount,
            initialSyncComplete: isInitialSyncComplete(),
            highestSlot: this.highestSlot.toString()
        };
    }
}