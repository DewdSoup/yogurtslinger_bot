/**
 * OrphanBuffer — Production Grade
 *
 * Prevents B6.3 data loss + real-time health monitoring
 *
 * Features:
 * - Buffers tick/bin arrays before pool arrives
 * - Real-time divergence detection (not post-hoc)
 * - Health metrics for circuit breaker
 * - TTL-based cleanup
 * - Comprehensive stats for validation
 */

import type { TickArray, BinArray } from '../types.js';

function toHex(pubkey: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < 32; i++) {
        hex += pubkey[i]!.toString(16).padStart(2, '0');
    }
    return hex;
}

interface OrphanedTickArray {
    tickAccountPubkey: Uint8Array;
    array: TickArray;
    slot: number;
    writeVersion: bigint;
    dataLength: number;
    bufferedAtMs: number;
}

interface OrphanedBinArray {
    binAccountPubkey: Uint8Array;
    array: BinArray;
    slot: number;
    writeVersion: bigint;
    dataLength: number;
    bufferedAtMs: number;
}

export interface OrphanBufferHealth {
    /** Is buffer healthy? (reclaim rate ≥ threshold) */
    healthy: boolean;
    /** Current orphan count */
    currentOrphans: number;
    /** Reclaim rate (0.0 - 1.0) */
    reclaimRate: number;
    /** Max buffer delay in ms */
    maxBufferDelayMs: number;
    /** Avg buffer delay in ms */
    avgBufferDelayMs: number;
    /** Total buffered since start */
    totalBuffered: number;
    /** Total claimed since start */
    totalClaimed: number;
    /** Total expired since start */
    totalExpired: number;
}

export interface OrphanBufferStats extends OrphanBufferHealth {
    ticksBuffered: number;
    ticksClaimed: number;
    ticksExpired: number;
    binsBuffered: number;
    binsClaimed: number;
    binsExpired: number;
}

export interface OrphanBufferConfig {
    /** TTL before orphan expires (default: 60s) */
    ttlMs?: number;
    /** Reclaim rate threshold for health (default: 0.95) */
    healthThreshold?: number;
    /** Max orphans before warning (default: 1000) */
    maxOrphansWarning?: number;
}

/**
 * Production-grade orphan buffer
 */
export class OrphanBuffer {
    // Storage
    private tickOrphans = new Map<string, OrphanedTickArray>();
    private binOrphans = new Map<string, OrphanedBinArray>();

    // Reverse index: poolId → Set<arrayPubkey>
    private tickPoolIndex = new Map<string, Set<string>>();
    private binPoolIndex = new Map<string, Set<string>>();

    // Stats
    private ticksBuffered = 0;
    private ticksClaimed = 0;
    private ticksExpired = 0;
    private binsBuffered = 0;
    private binsClaimed = 0;
    private binsExpired = 0;

    // Health tracking
    private bufferDelays: number[] = [];
    private readonly MAX_DELAY_SAMPLES = 1000;

    // Config
    private readonly ttlMs: number;
    private readonly healthThreshold: number;
    private readonly maxOrphansWarning: number;

    constructor(config: OrphanBufferConfig = {}) {
        this.ttlMs = config.ttlMs ?? 60000;
        this.healthThreshold = config.healthThreshold ?? 0.95;
        this.maxOrphansWarning = config.maxOrphansWarning ?? 1000;
    }

    /**
     * Buffer a tick array for later claim
     */
    addTickArray(
        tickAccountPubkey: Uint8Array,
        array: TickArray,
        slot: number,
        writeVersion: bigint,
        dataLength: number
    ): void {
        const pubkeyHex = toHex(tickAccountPubkey);
        const poolHex = toHex(array.poolId);

        this.tickOrphans.set(pubkeyHex, {
            tickAccountPubkey,
            array,
            slot,
            writeVersion,
            dataLength,
            bufferedAtMs: Date.now(),
        });

        // Update reverse index
        if (!this.tickPoolIndex.has(poolHex)) {
            this.tickPoolIndex.set(poolHex, new Set());
        }
        this.tickPoolIndex.get(poolHex)!.add(pubkeyHex);

        this.ticksBuffered++;

        // Warning if buffer getting large
        if (this.tickOrphans.size > this.maxOrphansWarning) {
            console.warn(`[OrphanBuffer] Large tick buffer: ${this.tickOrphans.size} orphans (threshold: ${this.maxOrphansWarning})`);
        }
    }

    /**
     * Buffer a bin array for later claim
     */
    addBinArray(
        binAccountPubkey: Uint8Array,
        array: BinArray,
        slot: number,
        writeVersion: bigint,
        dataLength: number
    ): void {
        const pubkeyHex = toHex(binAccountPubkey);
        const poolHex = toHex(array.lbPair);

        this.binOrphans.set(pubkeyHex, {
            binAccountPubkey,
            array,
            slot,
            writeVersion,
            dataLength,
            bufferedAtMs: Date.now(),
        });

        // Update reverse index
        if (!this.binPoolIndex.has(poolHex)) {
            this.binPoolIndex.set(poolHex, new Set());
        }
        this.binPoolIndex.get(poolHex)!.add(pubkeyHex);

        this.binsBuffered++;

        // Warning if buffer getting large
        if (this.binOrphans.size > this.maxOrphansWarning) {
            console.warn(`[OrphanBuffer] Large bin buffer: ${this.binOrphans.size} orphans (threshold: ${this.maxOrphansWarning})`);
        }
    }

    /**
     * Claim all orphaned tick arrays for a pool
     */
    claimTickArrays(poolPubkey: Uint8Array): OrphanedTickArray[] {
        const poolHex = toHex(poolPubkey);
        const orphanPubkeys = this.tickPoolIndex.get(poolHex);
        if (!orphanPubkeys) return [];

        const claimed: OrphanedTickArray[] = [];
        const now = Date.now();

        for (const pubkeyHex of orphanPubkeys) {
            const orphan = this.tickOrphans.get(pubkeyHex);
            if (orphan) {
                claimed.push(orphan);

                // Track buffer delay
                const delay = now - orphan.bufferedAtMs;
                this.trackBufferDelay(delay);

                this.tickOrphans.delete(pubkeyHex);
                this.ticksClaimed++;
            }
        }

        this.tickPoolIndex.delete(poolHex);
        return claimed;
    }

    /**
     * Claim all orphaned bin arrays for a pool
     */
    claimBinArrays(poolPubkey: Uint8Array): OrphanedBinArray[] {
        const poolHex = toHex(poolPubkey);
        const orphanPubkeys = this.binPoolIndex.get(poolHex);
        if (!orphanPubkeys) return [];

        const claimed: OrphanedBinArray[] = [];
        const now = Date.now();

        for (const pubkeyHex of orphanPubkeys) {
            const orphan = this.binOrphans.get(pubkeyHex);
            if (orphan) {
                claimed.push(orphan);

                // Track buffer delay
                const delay = now - orphan.bufferedAtMs;
                this.trackBufferDelay(delay);

                this.binOrphans.delete(pubkeyHex);
                this.binsClaimed++;
            }
        }

        this.binPoolIndex.delete(poolHex);
        return claimed;
    }

    /**
     * Track buffer delay for health metrics
     */
    private trackBufferDelay(delayMs: number): void {
        this.bufferDelays.push(delayMs);
        // Keep only recent samples
        if (this.bufferDelays.length > this.MAX_DELAY_SAMPLES) {
            this.bufferDelays.shift();
        }
    }

    /**
     * Cleanup expired orphans
     */
    cleanup(): { ticksExpired: number; binsExpired: number } {
        const now = Date.now();
        let ticksExpired = 0;
        let binsExpired = 0;

        // Cleanup tick arrays
        const expiredTicks: string[] = [];
        for (const [pubkeyHex, orphan] of this.tickOrphans) {
            if (now - orphan.bufferedAtMs > this.ttlMs) {
                expiredTicks.push(pubkeyHex);
            }
        }

        for (const pubkeyHex of expiredTicks) {
            this.tickOrphans.delete(pubkeyHex);
            this.ticksExpired++;
            ticksExpired++;

            // Clean reverse index
            for (const [poolHex, set] of this.tickPoolIndex) {
                set.delete(pubkeyHex);
                if (set.size === 0) {
                    this.tickPoolIndex.delete(poolHex);
                }
            }
        }

        // Cleanup bin arrays
        const expiredBins: string[] = [];
        for (const [pubkeyHex, orphan] of this.binOrphans) {
            if (now - orphan.bufferedAtMs > this.ttlMs) {
                expiredBins.push(pubkeyHex);
            }
        }

        for (const pubkeyHex of expiredBins) {
            this.binOrphans.delete(pubkeyHex);
            this.binsExpired++;
            binsExpired++;

            // Clean reverse index
            for (const [poolHex, set] of this.binPoolIndex) {
                set.delete(pubkeyHex);
                if (set.size === 0) {
                    this.binPoolIndex.delete(poolHex);
                }
            }
        }

        return { ticksExpired, binsExpired };
    }

    /**
     * Get health status
     */
    health(): OrphanBufferHealth {
        const totalBuffered = this.ticksBuffered + this.binsBuffered;
        const totalClaimed = this.ticksClaimed + this.binsClaimed;
        const totalExpired = this.ticksExpired + this.binsExpired;

        const reclaimRate = totalBuffered > 0 ? totalClaimed / totalBuffered : 1.0;
        const healthy = reclaimRate >= this.healthThreshold;

        const maxBufferDelayMs = this.bufferDelays.length > 0 ? Math.max(...this.bufferDelays) : 0;
        const avgBufferDelayMs = this.bufferDelays.length > 0
            ? this.bufferDelays.reduce((a, b) => a + b, 0) / this.bufferDelays.length
            : 0;

        return {
            healthy,
            currentOrphans: this.tickOrphans.size + this.binOrphans.size,
            reclaimRate,
            maxBufferDelayMs,
            avgBufferDelayMs,
            totalBuffered,
            totalClaimed,
            totalExpired,
        };
    }

    /**
     * Get detailed stats
     */
    stats(): OrphanBufferStats {
        const health = this.health();
        return {
            ...health,
            ticksBuffered: this.ticksBuffered,
            ticksClaimed: this.ticksClaimed,
            ticksExpired: this.ticksExpired,
            binsBuffered: this.binsBuffered,
            binsClaimed: this.binsClaimed,
            binsExpired: this.binsExpired,
        };
    }

    /**
     * Reset stats (for testing)
     */
    reset(): void {
        this.tickOrphans.clear();
        this.binOrphans.clear();
        this.tickPoolIndex.clear();
        this.binPoolIndex.clear();
        this.ticksBuffered = 0;
        this.ticksClaimed = 0;
        this.ticksExpired = 0;
        this.binsBuffered = 0;
        this.binsClaimed = 0;
        this.binsExpired = 0;
        this.bufferDelays.length = 0;
    }
}

/**
 * Create orphan buffer instance
 */
export function createOrphanBuffer(config?: OrphanBufferConfig): OrphanBuffer {
    return new OrphanBuffer(config);
}