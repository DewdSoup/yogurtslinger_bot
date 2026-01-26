/**
 * Pre-allocated Buffer Pool
 * 
 * Zero-allocation buffer management for hot path.
 * Avoids GC pressure during critical operations.
 */

import type { BufferPool as IBufferPool } from '../types.js';

interface PooledBuffer {
    buffer: Uint8Array;
    inUse: boolean;
}

export class BufferPool implements IBufferPool {
    private pools: Map<number, PooledBuffer[]> = new Map();
    private allocated = 0;
    private maxSize: number;

    constructor(maxSize: number = 100 * 1024 * 1024) { // 100MB default
        this.maxSize = maxSize;
    }

    /**
     * Pre-allocate buffers of specific sizes
     */
    preallocate(size: number, count: number): void {
        let pool = this.pools.get(size);
        if (!pool) {
            pool = [];
            this.pools.set(size, pool);
        }

        for (let i = 0; i < count; i++) {
            if (this.allocated + size > this.maxSize) break;
            pool.push({
                buffer: new Uint8Array(size),
                inUse: false,
            });
            this.allocated += size;
        }
    }

    /**
     * Acquire buffer of at least `size` bytes
     */
    acquire(size: number): Uint8Array {
        // Find smallest pool that fits
        const sizes = Array.from(this.pools.keys()).sort((a, b) => a - b);

        for (const poolSize of sizes) {
            if (poolSize >= size) {
                const pool = this.pools.get(poolSize)!;
                const available = pool.find(p => !p.inUse);
                if (available) {
                    available.inUse = true;
                    return available.buffer.subarray(0, size);
                }
            }
        }

        // No available buffer, allocate new
        if (this.allocated + size <= this.maxSize) {
            const roundedSize = this.roundUpSize(size);
            let pool = this.pools.get(roundedSize);
            if (!pool) {
                pool = [];
                this.pools.set(roundedSize, pool);
            }

            const entry: PooledBuffer = {
                buffer: new Uint8Array(roundedSize),
                inUse: true,
            };
            pool.push(entry);
            this.allocated += roundedSize;
            return entry.buffer.subarray(0, size);
        }

        // Pool exhausted, create temporary buffer (will be GC'd)
        return new Uint8Array(size);
    }

    /**
     * Release buffer back to pool
     */
    release(buf: Uint8Array): void {
        // Find buffer in pools
        for (const pool of this.pools.values()) {
            for (const entry of pool) {
                if (entry.buffer.buffer === buf.buffer) {
                    entry.inUse = false;
                    // Zero buffer for security
                    entry.buffer.fill(0);
                    return;
                }
            }
        }
        // Buffer not from pool, will be GC'd
    }

    /**
     * Get pool statistics
     */
    stats(): { allocated: number; available: number; maxSize: number } {
        let available = 0;
        for (const pool of this.pools.values()) {
            for (const entry of pool) {
                if (!entry.inUse) {
                    available += entry.buffer.length;
                }
            }
        }

        return {
            allocated: this.allocated,
            available,
            maxSize: this.maxSize,
        };
    }

    /**
     * Round up to power of 2 for efficient pooling
     */
    private roundUpSize(size: number): number {
        if (size <= 64) return 64;
        if (size <= 256) return 256;
        if (size <= 1024) return 1024;
        if (size <= 4096) return 4096;
        if (size <= 16384) return 16384;
        if (size <= 65536) return 65536;
        return Math.ceil(size / 65536) * 65536;
    }
}

/**
 * Global buffer pool instance
 */
export const bufferPool = new BufferPool();

/**
 * Initialize buffer pool with common sizes
 */
export function initBufferPool(): void {
    // Transaction buffers
    bufferPool.preallocate(1232, 100);  // Max tx size

    // Account data buffers
    bufferPool.preallocate(1024, 200);  // Small accounts
    bufferPool.preallocate(4096, 100);  // Medium accounts
    bufferPool.preallocate(16384, 50);  // Large accounts

    // Pubkey buffers
    bufferPool.preallocate(32, 1000);   // Pubkeys
    bufferPool.preallocate(64, 500);    // Signatures
}