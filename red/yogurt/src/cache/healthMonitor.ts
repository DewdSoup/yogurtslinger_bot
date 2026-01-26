/**
 * Cache Health Monitor — Production Grade
 *
 * Real-time monitoring for MEV-grade cache reliability
 *
 * Features:
 * - Continuous cache parity validation
 * - Orphan buffer health monitoring
 * - Slot freshness checks
 * - Circuit breaker logic
 * - Integration with evidence capture
 */

import type { OrphanBuffer, OrphanBufferHealth } from './orphanBuffer.js';
import type { IPoolCache, ITickCache, IBinCache, IVaultCache } from './types.js';

export interface CacheHealthMetrics {
    /** Overall health status */
    healthy: boolean;
    /** Individual check statuses */
    checks: {
        orphanBufferHealthy: boolean;
        cacheParityHealthy: boolean;
        slotFreshnessHealthy: boolean;
        memoryHealthy: boolean;
    };
    /** Orphan buffer metrics */
    orphanBuffer: OrphanBufferHealth;
    /** Cache sizes */
    cacheSizes: {
        pools: number;
        vaults: number;
        ticks: number;
        bins: number;
    };
    /** Slot tracking */
    slots: {
        maxSlotSeen: number;
        poolsStale: number;
        ticksStale: number;
        binsStale: number;
    };
    /** Memory usage */
    memory: {
        heapUsedMB: number;
        heapTotalMB: number;
        rssMB: number;
    };
    /** Timestamp of check */
    checkedAtMs: number;
}

export interface HealthCheckConfig {
    /** Reclaim rate threshold (default: 0.95) */
    orphanReclaimThreshold?: number;
    /** Max slots behind for freshness (default: 2) */
    maxSlotsBehind?: number;
    /** Max orphan buffer size before unhealthy (default: 1000) */
    maxOrphanSize?: number;
    /** Max heap usage MB before warning (default: 5000) */
    maxHeapMB?: number;
    /** Enable console warnings (default: true) */
    enableWarnings?: boolean;
}

export interface CircuitBreakerState {
    /** Is circuit open? (execution blocked) */
    open: boolean;
    /** Reason circuit was opened */
    reason?: string;
    /** When circuit was opened */
    openedAtMs?: number;
    /** Number of consecutive unhealthy checks */
    consecutiveFailures: number;
}

/**
 * Cache Health Monitor
 *
 * Continuously validates cache state for production MEV
 */
export class CacheHealthMonitor {
    private orphanBuffer: OrphanBuffer;
    private poolCache: IPoolCache;
    private tickCache: ITickCache;
    private binCache: IBinCache;
    private vaultCache: IVaultCache;

    // Slot tracking
    private maxSlotSeen = 0;

    // Circuit breaker
    private circuitBreaker: CircuitBreakerState = {
        open: false,
        consecutiveFailures: 0,
    };

    // Config
    private readonly config: Required<HealthCheckConfig>;

    // Failure threshold before opening circuit
    private readonly CIRCUIT_BREAKER_THRESHOLD = 3;

    constructor(
        orphanBuffer: OrphanBuffer,
        poolCache: IPoolCache,
        tickCache: ITickCache,
        binCache: IBinCache,
        vaultCache: IVaultCache,
        config: HealthCheckConfig = {}
    ) {
        this.orphanBuffer = orphanBuffer;
        this.poolCache = poolCache;
        this.tickCache = tickCache;
        this.binCache = binCache;
        this.vaultCache = vaultCache;

        this.config = {
            orphanReclaimThreshold: config.orphanReclaimThreshold ?? 0.95,
            maxSlotsBehind: config.maxSlotsBehind ?? 2,
            maxOrphanSize: config.maxOrphanSize ?? 1000,
            maxHeapMB: config.maxHeapMB ?? 5000,
            enableWarnings: config.enableWarnings ?? true,
        };
    }

    /**
     * Update max slot seen (call from gRPC handler)
     */
    updateSlot(slot: number): void {
        if (slot > this.maxSlotSeen) {
            this.maxSlotSeen = slot;
        }
    }

    /**
     * Perform health check
     */
    check(): CacheHealthMetrics {
        const now = Date.now();

        // 1. Orphan buffer health
        const orphanHealth = this.orphanBuffer.health();
        const orphanBufferHealthy =
            orphanHealth.healthy &&
            orphanHealth.currentOrphans < this.config.maxOrphanSize;

        // 2. Cache sizes (parity check - should have entries)
        const poolStats = this.poolCache.stats();
        const tickStats = this.tickCache.stats();
        const binStats = this.binCache.stats();
        const vaultStats = this.vaultCache.stats();

        const cacheParityHealthy =
            poolStats.size > 0 && // Should have pools
            vaultStats.size > 0; // Should have vaults

        // 3. Slot freshness
        const poolsStale = this.countStaleEntries(poolStats.lastUpdateSlot);
        const ticksStale = this.countStaleEntries(tickStats.lastUpdateSlot);
        const binsStale = this.countStaleEntries(binStats.lastUpdateSlot);

        const slotFreshnessHealthy =
            poolsStale === 0 &&
            ticksStale === 0 &&
            binsStale === 0;

        // 4. Memory health
        const memUsage = process.memoryUsage();
        const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
        const heapTotalMB = memUsage.heapTotal / 1024 / 1024;
        const rssMB = memUsage.rss / 1024 / 1024;

        const memoryHealthy = heapUsedMB < this.config.maxHeapMB;

        // Overall health
        const healthy =
            orphanBufferHealthy &&
            cacheParityHealthy &&
            slotFreshnessHealthy &&
            memoryHealthy;

        // Update circuit breaker
        this.updateCircuitBreaker(healthy);

        // Warnings
        if (this.config.enableWarnings && !healthy) {
            this.emitWarnings({
                orphanBufferHealthy,
                cacheParityHealthy,
                slotFreshnessHealthy,
                memoryHealthy,
            }, orphanHealth);
        }

        return {
            healthy,
            checks: {
                orphanBufferHealthy,
                cacheParityHealthy,
                slotFreshnessHealthy,
                memoryHealthy,
            },
            orphanBuffer: orphanHealth,
            cacheSizes: {
                pools: poolStats.size,
                vaults: vaultStats.size,
                ticks: tickStats.size,
                bins: binStats.size,
            },
            slots: {
                maxSlotSeen: this.maxSlotSeen,
                poolsStale,
                ticksStale,
                binsStale,
            },
            memory: {
                heapUsedMB,
                heapTotalMB,
                rssMB,
            },
            checkedAtMs: now,
        };
    }

    /**
     * Count stale entries (more than maxSlotsBehind)
     */
    private countStaleEntries(lastUpdateSlot: number): number {
        const slotsBehind = this.maxSlotSeen - lastUpdateSlot;
        return slotsBehind > this.config.maxSlotsBehind ? 1 : 0;
    }

    /**
     * Update circuit breaker state
     */
    private updateCircuitBreaker(healthy: boolean): void {
        if (!healthy) {
            this.circuitBreaker.consecutiveFailures++;

            if (this.circuitBreaker.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
                if (!this.circuitBreaker.open) {
                    this.circuitBreaker.open = true;
                    this.circuitBreaker.openedAtMs = Date.now();
                    this.circuitBreaker.reason = 'Cache health degraded';

                    console.error(
                        `[CacheHealthMonitor] CIRCUIT BREAKER OPENED: ` +
                        `${this.circuitBreaker.consecutiveFailures} consecutive failures`
                    );
                }
            }
        } else {
            // Reset on healthy check
            if (this.circuitBreaker.consecutiveFailures > 0) {
                this.circuitBreaker.consecutiveFailures = 0;
            }
            if (this.circuitBreaker.open) {
                this.circuitBreaker.open = false;
                this.circuitBreaker.reason = undefined;
                this.circuitBreaker.openedAtMs = undefined;

                console.log('[CacheHealthMonitor] Circuit breaker CLOSED (health restored)');
            }
        }
    }

    /**
     * Emit warnings for failed checks
     */
    private emitWarnings(
        checks: {
            orphanBufferHealthy: boolean;
            cacheParityHealthy: boolean;
            slotFreshnessHealthy: boolean;
            memoryHealthy: boolean;
        },
        orphanHealth: OrphanBufferHealth
    ): void {
        if (!checks.orphanBufferHealthy) {
            console.warn(
                `[CacheHealthMonitor] ORPHAN BUFFER UNHEALTHY: ` +
                `reclaim=${(orphanHealth.reclaimRate * 100).toFixed(1)}% ` +
                `(threshold=${(this.config.orphanReclaimThreshold * 100).toFixed(0)}%), ` +
                `current=${orphanHealth.currentOrphans} ` +
                `(max=${this.config.maxOrphanSize})`
            );
        }

        if (!checks.cacheParityHealthy) {
            console.warn(
                `[CacheHealthMonitor] CACHE PARITY ISSUE: ` +
                `pools=${this.poolCache.stats().size}, ` +
                `vaults=${this.vaultCache.stats().size}`
            );
        }

        if (!checks.slotFreshnessHealthy) {
            const poolSlotsBehind = this.maxSlotSeen - this.poolCache.stats().lastUpdateSlot;
            const tickSlotsBehind = this.maxSlotSeen - this.tickCache.stats().lastUpdateSlot;
            const binSlotsBehind = this.maxSlotSeen - this.binCache.stats().lastUpdateSlot;

            console.warn(
                `[CacheHealthMonitor] SLOT FRESHNESS ISSUE: ` +
                `pools=${poolSlotsBehind} behind, ` +
                `ticks=${tickSlotsBehind} behind, ` +
                `bins=${binSlotsBehind} behind ` +
                `(max=${this.config.maxSlotsBehind})`
            );
        }

        if (!checks.memoryHealthy) {
            const heapUsedMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
            console.warn(
                `[CacheHealthMonitor] MEMORY PRESSURE: ` +
                `heap=${heapUsedMB}MB ` +
                `(max=${this.config.maxHeapMB}MB)`
            );
        }
    }

    /**
     * Get circuit breaker state
     */
    getCircuitBreaker(): CircuitBreakerState {
        return { ...this.circuitBreaker };
    }

    /**
     * Manually open circuit breaker
     */
    openCircuit(reason: string): void {
        this.circuitBreaker.open = true;
        this.circuitBreaker.reason = reason;
        this.circuitBreaker.openedAtMs = Date.now();

        console.error(`[CacheHealthMonitor] CIRCUIT BREAKER MANUALLY OPENED: ${reason}`);
    }

    /**
     * Manually close circuit breaker
     */
    closeCircuit(): void {
        this.circuitBreaker.open = false;
        this.circuitBreaker.reason = undefined;
        this.circuitBreaker.openedAtMs = undefined;
        this.circuitBreaker.consecutiveFailures = 0;

        console.log('[CacheHealthMonitor] Circuit breaker manually CLOSED');
    }

    /**
     * Check if execution should be blocked
     */
    shouldBlockExecution(): boolean {
        return this.circuitBreaker.open;
    }
}

/**
 * Create health monitor instance
 */
export function createHealthMonitor(
    orphanBuffer: OrphanBuffer,
    poolCache: IPoolCache,
    tickCache: ITickCache,
    binCache: IBinCache,
    vaultCache: IVaultCache,
    config?: HealthCheckConfig
): CacheHealthMonitor {
    return new CacheHealthMonitor(
        orphanBuffer,
        poolCache,
        tickCache,
        binCache,
        vaultCache,
        config
    );
}