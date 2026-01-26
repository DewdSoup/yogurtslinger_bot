/**
 * Revenue Logger (Live Revenue Analysis)
 *
 * Logs profitable opportunities to data/opportunities.jsonl
 * for analysis and monitoring.
 *
 * Phase A-1: Async buffered writes - no sync I/O on hot path.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VenueId } from '../types.js';

/** Minimum profit threshold in lamports (0.001 SOL = 1,000,000 lamports) */
const DUST_THRESHOLD_LAMPORTS = 1_000_000n;

/** Lamports per SOL for conversion */
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Output file path */
const OUTPUT_PATH = 'data/opportunities.jsonl';

/** Flush interval in milliseconds */
const FLUSH_INTERVAL_MS = 1000;

/** Max buffer size before forcing flush */
const MAX_BUFFER_SIZE = 100;

/** Venue ID to string mapping */
const VENUE_NAMES: Record<VenueId, string> = {
    0: 'PumpSwap',
    1: 'RaydiumV4',
    2: 'RaydiumClmm',
    3: 'MeteoraDlmm',
};

export interface OpportunityLogEntry {
    slot: number;
    venue: string;
    route: string[];
    inputAmount: string;
    outputAmount: string;
    profitLamports: string;
    profitSol: number;
    latencyUs: number;
    timestamp: string;
}

export interface LogParams {
    slot: number;
    venue: VenueId;
    route: Uint8Array[];  // Array of mint pubkeys
    inputAmount: bigint;
    outputAmount: bigint;
    latencyUs: number;
}

/**
 * Convert Uint8Array pubkey to base58-like hex string (shorter for logs)
 */
function pubkeyToHex(pubkey: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < pubkey.length; i++) {
        hex += pubkey[i]!.toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * RevenueLogger singleton for logging profitable opportunities
 * Uses in-memory buffering with async flush to avoid blocking hot path.
 */
export const RevenueLogger = {
    _initialized: false,
    _buffer: [] as string[],
    _flushTimer: null as ReturnType<typeof setInterval> | null,
    _flushing: false,

    _ensureDir(): void {
        if (this._initialized) return;
        const dir = dirname(OUTPUT_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this._startFlushTimer();
        this._registerExitHandler();
        this._initialized = true;
    },

    _startFlushTimer(): void {
        if (this._flushTimer) return;
        this._flushTimer = setInterval(() => {
            this._flushAsync();
        }, FLUSH_INTERVAL_MS);
        // Don't block process exit
        this._flushTimer.unref();
    },

    _registerExitHandler(): void {
        const flushSync = () => {
            if (this._buffer.length === 0) return;
            // On exit, do synchronous write to ensure data is persisted
            const { writeFileSync } = require('node:fs');
            try {
                writeFileSync(OUTPUT_PATH, this._buffer.join(''), { flag: 'a' });
                this._buffer.length = 0;
            } catch {
                // Best effort on exit
            }
        };
        process.on('exit', flushSync);
        process.on('SIGINT', () => {
            flushSync();
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            flushSync();
            process.exit(0);
        });
    },

    async _flushAsync(): Promise<void> {
        if (this._flushing || this._buffer.length === 0) return;
        this._flushing = true;

        // Swap buffer to avoid blocking new entries during write
        const toWrite = this._buffer;
        this._buffer = [];

        try {
            await appendFile(OUTPUT_PATH, toWrite.join(''));
        } catch (err) {
            // On failure, put entries back (prepend to preserve order)
            this._buffer = toWrite.concat(this._buffer);
            console.error('[RevenueLogger] Async flush failed:', err);
        } finally {
            this._flushing = false;
        }
    },

    _bufferEntry(entry: OpportunityLogEntry): void {
        this._buffer.push(JSON.stringify(entry) + '\n');

        // Trigger async flush if buffer is large
        if (this._buffer.length >= MAX_BUFFER_SIZE) {
            this._flushAsync();
        }
    },

    /**
     * Log a profitable opportunity
     *
     * @param params - Opportunity parameters
     * @returns true if logged, false if filtered (dust or negative profit)
     */
    log(params: LogParams): boolean {
        const { slot, venue, route, inputAmount, outputAmount, latencyUs } = params;

        // Calculate profit
        const profitLamports = outputAmount - inputAmount;

        // Dust filter: skip if profit is below threshold or negative
        if (profitLamports < DUST_THRESHOLD_LAMPORTS) {
            return false;
        }

        this._ensureDir();

        const entry: OpportunityLogEntry = {
            slot,
            venue: VENUE_NAMES[venue] ?? `Unknown(${venue})`,
            route: route.map(pubkeyToHex),
            inputAmount: inputAmount.toString(),
            outputAmount: outputAmount.toString(),
            profitLamports: profitLamports.toString(),
            profitSol: Number(profitLamports) / LAMPORTS_PER_SOL,
            latencyUs,
            timestamp: new Date().toISOString(),
        };

        this._bufferEntry(entry);
        return true;
    },

    /**
     * Log a multi-hop opportunity
     * Uses 'multihop' as venue name when multiple venues are involved
     */
    logMultiHop(params: {
        slot: number;
        venues: VenueId[];
        route: Uint8Array[];
        inputAmount: bigint;
        outputAmount: bigint;
        totalLatencyUs: number;
    }): boolean {
        const { slot, venues, route, inputAmount, outputAmount, totalLatencyUs } = params;

        // Calculate profit
        const profitLamports = outputAmount - inputAmount;

        // Dust filter
        if (profitLamports < DUST_THRESHOLD_LAMPORTS) {
            return false;
        }

        this._ensureDir();

        // Determine venue string
        const uniqueVenues = [...new Set(venues)];
        const venueStr = uniqueVenues.length === 1
            ? VENUE_NAMES[uniqueVenues[0]!] ?? `Unknown(${uniqueVenues[0]})`
            : `multihop(${uniqueVenues.map(v => VENUE_NAMES[v] ?? v).join(',')})`;

        const entry: OpportunityLogEntry = {
            slot,
            venue: venueStr,
            route: route.map(pubkeyToHex),
            inputAmount: inputAmount.toString(),
            outputAmount: outputAmount.toString(),
            profitLamports: profitLamports.toString(),
            profitSol: Number(profitLamports) / LAMPORTS_PER_SOL,
            latencyUs: totalLatencyUs,
            timestamp: new Date().toISOString(),
        };

        this._bufferEntry(entry);
        return true;
    },

    /**
     * Manually flush buffer (for testing or graceful shutdown)
     */
    async flush(): Promise<void> {
        await this._flushAsync();
    },

    /**
     * Get current buffer size (for monitoring)
     */
    getBufferSize(): number {
        return this._buffer.length;
    },
};
