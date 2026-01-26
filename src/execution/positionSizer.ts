// src/execution/positionSizer.ts
// Capital management and position sizing for arbitrage trades

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ============================================================================
// CAPITAL CONFIGURATION
// ============================================================================

export interface CapitalConfig {
    totalCapitalLamports: bigint;
    maxPerTradeLamports: bigint;
    maxPerTradePercent: number;
    reservePercent: number;
    minTradeLamports: bigint;
    maxConcurrentTrades: number;
}

export function createCapitalConfig(
    usdAmount: number,
    solPriceUsd: number = 238
): CapitalConfig {
    const solAmount = usdAmount / solPriceUsd;
    const totalLamports = BigInt(Math.floor(solAmount * 1e9));

    return {
        totalCapitalLamports: totalLamports,
        maxPerTradeLamports: totalLamports / 4n,
        maxPerTradePercent: 0.25,
        reservePercent: 0.10,
        minTradeLamports: LAMPORTS_PER_SOL / 10n,
        maxConcurrentTrades: 4
    };
}

export const DEFAULT_CONFIG: CapitalConfig = {
    totalCapitalLamports: 8_400_000_000n,
    maxPerTradeLamports: 2_100_000_000n,
    maxPerTradePercent: 0.25,
    reservePercent: 0.10,
    minTradeLamports: 100_000_000n,
    maxConcurrentTrades: 4
};

// ============================================================================
// POSITION TRACKING
// ============================================================================

export interface OpenPosition {
    id: string;
    tokenMint: string;
    amountLamports: bigint;
    openedAt: number;
    buyPool: string;
    sellPool: string;
    expectedProfit: bigint;
}

class PositionTracker {
    private positions: Map<string, OpenPosition> = new Map();
    private totalAllocated: bigint = 0n;

    open(position: OpenPosition): void {
        this.positions.set(position.id, position);
        this.totalAllocated += position.amountLamports;
    }

    close(id: string): OpenPosition | undefined {
        const position = this.positions.get(id);
        if (position) {
            this.positions.delete(id);
            this.totalAllocated -= position.amountLamports;
        }
        return position;
    }

    get(id: string): OpenPosition | undefined {
        return this.positions.get(id);
    }

    getAll(): OpenPosition[] {
        return Array.from(this.positions.values());
    }

    count(): number {
        return this.positions.size;
    }

    getAllocated(): bigint {
        return this.totalAllocated;
    }

    hasToken(tokenMint: string): boolean {
        for (const pos of this.positions.values()) {
            if (pos.tokenMint === tokenMint) return true;
        }
        return false;
    }

    clear(): void {
        this.positions.clear();
        this.totalAllocated = 0n;
    }
}

const positionTracker = new PositionTracker();

// ============================================================================
// SIZING LOGIC
// ============================================================================

export interface LiquidityInfo {
    poolLiquidityLamports: bigint;
    maxPoolImpactPercent: number;
}

// FIX: Changed from `reason?: string | undefined` to `reason: string | null`
// This fixes exactOptionalPropertyTypes errors in TypeScript strict mode
export interface SizeResult {
    tradeSizeLamports: bigint;
    tradeSizeSol: number;
    constraint: "capital" | "liquidity" | "concurrency" | "minimum" | "none";
    canTrade: boolean;
    reason: string | null;  // FIXED: Always provide a value (string or null)
}

export function calculateTradeSize(
    config: CapitalConfig,
    liquidity: LiquidityInfo
): SizeResult {
    if (positionTracker.count() >= config.maxConcurrentTrades) {
        return {
            tradeSizeLamports: 0n,
            tradeSizeSol: 0,
            constraint: "concurrency",
            canTrade: false,
            reason: `Max concurrent trades reached (${config.maxConcurrentTrades})`
        };
    }

    const reserved = (config.totalCapitalLamports * BigInt(Math.floor(config.reservePercent * 100))) / 100n;
    const available = config.totalCapitalLamports - reserved - positionTracker.getAllocated();

    if (available < config.minTradeLamports) {
        return {
            tradeSizeLamports: 0n,
            tradeSizeSol: 0,
            constraint: "capital",
            canTrade: false,
            reason: `Insufficient capital: ${Number(available) / 1e9} SOL available`
        };
    }

    const capitalMax = config.maxPerTradeLamports < available
        ? config.maxPerTradeLamports
        : available;

    const remainingSlots = config.maxConcurrentTrades - positionTracker.count();
    const concurrencyMax = available / BigInt(remainingSlots);

    const liquidityMax = (liquidity.poolLiquidityLamports *
        BigInt(Math.floor(liquidity.maxPoolImpactPercent * 100))) / 100n;

    let tradeSizeLamports = capitalMax;
    let constraint: "capital" | "liquidity" | "concurrency" | "minimum" | "none" = "capital";

    if (concurrencyMax < tradeSizeLamports) {
        tradeSizeLamports = concurrencyMax;
        constraint = "concurrency";
    }

    if (liquidityMax < tradeSizeLamports) {
        tradeSizeLamports = liquidityMax;
        constraint = "liquidity";
    }

    if (tradeSizeLamports < config.minTradeLamports) {
        return {
            tradeSizeLamports: 0n,
            tradeSizeSol: 0,
            constraint: "minimum",
            canTrade: false,
            reason: `Trade size ${Number(tradeSizeLamports) / 1e9} SOL below minimum`
        };
    }

    return {
        tradeSizeLamports,
        tradeSizeSol: Number(tradeSizeLamports) / 1e9,
        constraint,
        canTrade: true,
        reason: null  // FIXED: Use null instead of undefined
    };
}

export function calculateAggressiveSize(
    config: CapitalConfig,
    liquidity: LiquidityInfo,
    spreadPercent: number
): SizeResult {
    const baseResult = calculateTradeSize(config, liquidity);
    if (!baseResult.canTrade) return baseResult;
    if (spreadPercent < 1.5) return baseResult;

    const aggressiveSize = (baseResult.tradeSizeLamports * 150n) / 100n;
    const liquidityMax = (liquidity.poolLiquidityLamports *
        BigInt(Math.floor(liquidity.maxPoolImpactPercent * 100))) / 100n;

    const finalSize = aggressiveSize < liquidityMax ? aggressiveSize : liquidityMax;

    return {
        tradeSizeLamports: finalSize,
        tradeSizeSol: Number(finalSize) / 1e9,
        constraint: baseResult.constraint,
        canTrade: true,
        reason: null  // FIXED
    };
}

export function calculateConservativeSize(
    config: CapitalConfig,
    liquidity: LiquidityInfo
): SizeResult {
    const baseResult = calculateTradeSize(config, liquidity);
    if (!baseResult.canTrade) return baseResult;

    const conservativeSize = baseResult.tradeSizeLamports / 2n;

    if (conservativeSize < config.minTradeLamports) {
        return {
            ...baseResult,
            tradeSizeLamports: config.minTradeLamports,
            tradeSizeSol: Number(config.minTradeLamports) / 1e9,
        };
    }

    return {
        tradeSizeLamports: conservativeSize,
        tradeSizeSol: Number(conservativeSize) / 1e9,
        constraint: baseResult.constraint,
        canTrade: true,
        reason: null  // FIXED
    };
}

// ============================================================================
// POSITION MANAGEMENT FUNCTIONS
// ============================================================================

export function openPosition(position: OpenPosition): void {
    positionTracker.open(position);
}

export function closePosition(id: string): OpenPosition | undefined {
    return positionTracker.close(id);
}

export function getPosition(id: string): OpenPosition | undefined {
    return positionTracker.get(id);
}

export function getAllPositions(): OpenPosition[] {
    return positionTracker.getAll();
}

export function getPositionCount(): number {
    return positionTracker.count();
}

export function getAllocatedCapital(): bigint {
    return positionTracker.getAllocated();
}

export function hasOpenPositionForToken(tokenMint: string): boolean {
    return positionTracker.hasToken(tokenMint);
}

export function clearAllPositions(): void {
    positionTracker.clear();
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function getAvailableCapital(config: CapitalConfig): bigint {
    const reserved = (config.totalCapitalLamports * BigInt(Math.floor(config.reservePercent * 100))) / 100n;
    return config.totalCapitalLamports - reserved - positionTracker.getAllocated();
}

export function getRemainingSlots(config: CapitalConfig): number {
    return config.maxConcurrentTrades - positionTracker.count();
}

export function getCapitalUtilization(config: CapitalConfig): number {
    const allocated = positionTracker.getAllocated();
    return Number(allocated) / Number(config.totalCapitalLamports);
}

export function getPositionSummary(config: CapitalConfig): {
    openPositions: number;
    allocatedSol: number;
    availableSol: number;
    utilizationPercent: number;
    remainingSlots: number;
} {
    const allocated = positionTracker.getAllocated();
    const available = getAvailableCapital(config);

    return {
        openPositions: positionTracker.count(),
        allocatedSol: Number(allocated) / 1e9,
        availableSol: Number(available) / 1e9,
        utilizationPercent: getCapitalUtilization(config) * 100,
        remainingSlots: getRemainingSlots(config)
    };
}

export default {
    DEFAULT_CONFIG,
    createCapitalConfig,
    calculateTradeSize,
    calculateAggressiveSize,
    calculateConservativeSize,
    openPosition,
    closePosition,
    getPosition,
    getAllPositions,
    getPositionCount,
    getAllocatedCapital,
    hasOpenPositionForToken,
    clearAllPositions,
    getAvailableCapital,
    getRemainingSlots,
    getCapitalUtilization,
    getPositionSummary
};