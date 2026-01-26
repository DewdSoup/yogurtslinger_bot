# Local Simulation Analysis Report

## Executive Summary

This report compares **yogurt's simulation infrastructure** (`/red/yogurt/src/sim/`) with **yogurt_bot's comprehensive local simulator** (`/yogurtslinger_bot/src/simulation/`). The yogurt_bot system offers several production-ready components that can significantly accelerate yogurt's path to live execution.

---

## 1. yogurt/src/sim Architecture (Current State)

### File Structure
```
yogurt/src/sim/
├── engine.ts           # Main simulation dispatcher
├── sequential.ts       # Multi-hop path validation
└── math/
    ├── constantProduct.ts   # CPMM (PumpSwap, RaydiumV4)
    ├── clmm.ts             # Raydium CLMM tick traversal
    ├── dlmm.ts             # Meteora DLMM bin traversal
    └── fees.ts             # Fee calculation utilities
```

### Key Characteristics

| Aspect | yogurt Current State |
|--------|---------------------|
| **Math Modules** | Full CPMM, CLMM (tick traverse), DLMM (bin traverse) |
| **Entry Point** | `simulate()` for single-hop, `simulateMultiHop()` for paths |
| **Type System** | Strong typing with `SimInput`, `SimResult`, `PoolState` |
| **State Mutation** | Returns `newPoolState` for chained simulation |
| **Latency Tracking** | Built-in `latencyUs` instrumentation |
| **Fee Handling** | Per-venue fee extraction from pool state |
| **Error Handling** | `ErrorClass` enum (InsufficientLiquidity, MathOverflow, etc.) |

### Strengths
- Clean separation of math modules per venue
- Pure BigInt arithmetic (no floating point drift)
- Proper tick/bin traversal for concentrated liquidity
- Q64/Q128 fixed-point math for CLMM
- Multi-hop simulation with state mutation

### Missing Components
1. **No arbitrage orchestration** - no unified arb simulation
2. **No optimal sizing** - binary search for profit maximization
3. **No confidence scoring** - venue complexity risk assessment
4. **No SimGate pattern** - RPC simulation fallback
5. **No accuracy tracking** - prediction vs actual comparison
6. **No pool state builder** - cache-to-sim state conversion

---

## 2. yogurt_bot/src/simulation Architecture

### File Structure
```
yogurt_bot/src/simulation/
├── localSimulator.ts      # Unified arb simulation engine
├── arbSimGate.ts          # Local SimGate (replaces RPC sim)
├── poolStateBuilder.ts    # Cache → PoolState conversion
├── simAccuracyTracker.ts  # Prediction vs actual tracking

yogurt_bot/src/brain/simulation/
└── simGate.ts             # RPC-based SimGate (for comparison)
```

### 2.1 LocalSimulator Architecture

**Location:** `/home/dudesoup/code/yogurtslinger_bot/src/simulation/localSimulator.ts`

#### Core Functions

```typescript
// Result types
interface SwapSimResult {
    amountOut: bigint;
    fee: bigint;
    priceImpactBps: number;
    effectivePrice: number;
}

interface ArbSimResult {
    profitable: boolean;
    optimalAmountIn: bigint;
    tokensReceived: bigint;
    solReceived: bigint;
    grossProfitLamports: bigint;
    netProfitLamports: bigint;
    netProfitBps: number;
    buyPriceImpactBps: number;
    sellPriceImpactBps: number;
    totalFeesPaid: bigint;
    simulationTimeMs: number;
    confidence: number;        // 0-1 based on venue complexity
    method: "cpmm" | "clmm" | "dlmm" | "mixed";
}
```

#### Key Functions

| Function | Purpose |
|----------|---------|
| `simulateCPMMSwap()` | Constant product: `dy = y * dx / (x + dx)` |
| `simulateCLMMSwapSingleTick()` | CLMM within single tick (approximation) |
| `simulateDLMMSwap()` | DLMM bin traversal with BinArrayCache |
| `simulateArbitrage()` | Full buy→sell simulation with profit calc |
| `findOptimalArbAmount()` | Binary search for profit maximization |
| `findOptimalCPMMAmount()` | Optimized CPMM-specific binary search |
| `quickProfitCheck()` | Fast filter before full simulation |
| `getConstrainingLiquidity()` | Position sizing constraints |

#### Binary Search Algorithm

```typescript
function findOptimalArbAmount(
    buyPool: PoolState,
    sellPool: PoolState,
    maxAmount: bigint,
    minProfitLamports: bigint = 50_000n,
    binArrayCache?: BinArrayCache
): OptimalSizeResult | null {
    const MAX_ITERATIONS = 40;  // ~1 trillion precision
    const MIN_TRADE_LAMPORTS = 10_000_000n;  // 0.01 SOL

    let lo = MIN_TRADE_LAMPORTS;
    let hi = maxAmount;
    let bestAmount = 0n;
    let bestProfit = 0n;

    for (let i = 0; i < MAX_ITERATIONS && lo < hi; i++) {
        const mid = (lo + hi) / 2n;

        const result = simulateArbitrage(buyPool, sellPool, mid, binArrayCache);

        if (result.profitable && result.grossProfitLamports > bestProfit) {
            bestProfit = result.grossProfitLamports;
            bestAmount = mid;
        }

        // Gradient check: is profit increasing?
        const midPlus = mid + mid / 100n;  // +1%
        const resultPlus = simulateArbitrage(buyPool, sellPool, midPlus);

        if (resultPlus.grossProfitLamports > result.grossProfitLamports) {
            lo = mid;  // Profit increasing, search higher
        } else {
            hi = mid;  // Profit decreasing, search lower
        }
    }

    return bestProfit >= minProfitLamports ? {
        optimalAmount: bestAmount,
        expectedProfit: bestProfit,
        profitBps: Number(bestProfit * 10000n / bestAmount),
        confidence: bestConfidence
    } : null;
}
```

#### Confidence Scoring System

```typescript
// Confidence assignment based on venue complexity
function getConfidence(buyType: string, sellType: string): number {
    if (buyType === "cpmm" && sellType === "cpmm") {
        return 0.99;  // CPMM math is exact
    } else if (buyType === sellType) {
        return buyType === "clmm" ? 0.90 : 0.92;  // Same venue type
    } else {
        return 0.85;  // Mixed venues have more uncertainty
    }
}

// Reduce confidence if bin data unavailable
if ((buyType === "dlmm" || sellType === "dlmm") && !binArrayCache) {
    confidence *= 0.9;
}
```

### 2.2 SimGate Pattern

**Location:** `/home/dudesoup/code/yogurtslinger_bot/src/simulation/arbSimGate.ts`

The SimGate pattern provides a validation layer between signal detection and execution.

#### Configuration

```typescript
interface SimGateConfig {
    minNetProfitBps: number;           // Default: 20
    minNetProfitLamports: bigint;      // Default: 50_000
    maxPriceImpactBps: number;         // Default: 200
    slippageTolerance: number;         // Default: 0.02 (2%)
    minConfidence: number;             // Default: 0.80
    useRpcFallback: boolean;           // Default: false
}
```

#### Validation Flow

```typescript
async function validateSignal(
    signal: ArbSignal,
    cache: MarketCache,
    binArrayCache: BinArrayCache | undefined,
    maxCapitalLamports: bigint,
    config: SimGateConfig
): Promise<SimGateResult> {
    // 1. Build pool states from cache
    const { buyPool, sellPool } = buildPoolStatesForToken(
        signal.tokenMint,
        signal.buyVenue,
        signal.sellVenue,
        { cache, tokenAccountCache }
    );

    // 2. Quick profit check (fast filter)
    const quickCheck = quickProfitCheck(buyPool, sellPool);
    if (!quickCheck.profitable) {
        return createRejectedResult("Quick check: not profitable");
    }

    // 3. Get constraining liquidity
    const liquidity = getConstrainingLiquidity(buyPool, sellPool);
    const maxAmount = min(liquidity.maxRecommendedSize, maxCapitalLamports);

    // 4. Find optimal amount via binary search
    const optimal = findOptimalArbAmount(buyPool, sellPool, maxAmount);
    if (!optimal) {
        return createRejectedResult("No profitable amount found");
    }

    // 5. Full simulation at optimal amount
    const simResult = simulateArbitrage(buyPool, sellPool, optimal.optimalAmount);

    // 6. Validation checks
    if (simResult.confidence < config.minConfidence) {
        return createRejectedResult(`Low confidence: ${simResult.confidence}`);
    }
    if (simResult.netProfitBps < config.minNetProfitBps) {
        return createRejectedResult(`Low profit: ${simResult.netProfitBps} bps`);
    }

    // 7. Calculate tip and slippage bounds
    const tip = calculateTip(simResult.grossProfitLamports, isFreshPool, spread);
    const minTokensOut = simResult.tokensReceived * (1 - slippageTolerance);

    return {
        approved: true,
        optimalAmountIn: optimal.optimalAmount,
        expectedProfitLamports: simResult.grossProfitLamports,
        minTokensOut,
        minSolOut,
        suggestedTipLamports: tip,
        confidence: simResult.confidence,
        buyPool,
        sellPool
    };
}
```

#### 90% RPC Savings Claim

The SimGate pattern claims 90% RPC savings by:

1. **Quick spread check** - Pure math, no RPC
2. **Liquidity constraints** - From cached reserves
3. **Binary search optimization** - All local simulation
4. **Confidence gating** - Reject low-confidence before RPC
5. **Only fall back to RPC** when `useRpcFallback: true` AND confidence < threshold

**Latency comparison:**
- RPC `simulateTransaction()`: 100-500ms (network + VM)
- Local SimGate: <1ms (pure math)

### 2.3 PoolStateBuilder

**Location:** `/home/dudesoup/code/yogurtslinger_bot/src/simulation/poolStateBuilder.ts`

Converts MarketCache entries to unified `PoolState` format.

#### Key Functions

```typescript
// Build pool state from specific venue
function buildPoolStateByPubkey(
    pubkey: string,
    venue: VenueName,
    options: { cache: MarketCache; tokenAccountCache: TokenAccountCache }
): PoolState | null;

// Build buy/sell pools for arbitrage
function buildPoolStatesForToken(
    tokenMint: string,
    buyVenue: VenueName,
    sellVenue: VenueName,
    options: BuildPoolStateOptions
): { buyPool: PoolState | null; sellPool: PoolState | null };

// Build all fragmented pool states
function buildAllFragmentedPoolStates(
    options: BuildPoolStateOptions
): Map<string, { pumpSwap?: PoolState; raydiumV4?: PoolState; ... }>;

// Find best arb pair across venues
function findBestArbPair(
    tokenMint: string,
    options: BuildPoolStateOptions
): { buyPool: PoolState; sellPool: PoolState; spreadBps: number } | null;
```

#### Venue-Specific Builders

Each venue has a dedicated builder that:
1. Extracts mint addresses and vault pubkeys
2. Fetches vault balances from TokenAccountCache
3. Normalizes to base=token, quote=SOL orientation
4. Extracts fee rates from pool state
5. Adds venue-specific extended data (clmmData, meteoraData)

### 2.4 SimAccuracyTracker

**Location:** `/home/dudesoup/code/yogurtslinger_bot/src/simulation/simAccuracyTracker.ts`

Tracks prediction accuracy against actual execution results.

#### Key Interfaces

```typescript
interface SimPrediction {
    tokenMint: string;
    buyVenue: string;
    sellVenue: string;
    predictedProfitLamports: bigint;
    predictedProfitBps: number;
    predictedTokensOut: bigint;
    predictedSolOut: bigint;
    optimalAmountIn: bigint;
    confidence: number;
    simulationTimeMs: number;
    timestamp: number;
}

interface AccuracyStats {
    totalPredictions: number;
    totalMatched: number;

    // Profit accuracy
    avgProfitErrorBps: number;
    profitWithin5Bps: number;
    profitWithin10Bps: number;

    // By venue pair
    byVenuePair: Map<string, {
        count: number;
        avgProfitErrorBps: number;
        successRate: number;
    }>;

    // By confidence bucket
    byConfidence: Map<string, {
        count: number;
        avgProfitErrorBps: number;
        successRate: number;
    }>;
}
```

#### Usage Pattern

```typescript
const tracker = new SimAccuracyTracker();

// Record prediction before execution
tracker.recordPrediction(
    tokenMint, buyVenue, sellVenue,
    predictedProfit, predictedBps,
    predictedTokens, predictedSol,
    optimalAmount, confidence, simTimeMs
);

// Record actual result after execution
tracker.recordActual(
    tokenMint,
    actualProfit, actualTokens, actualSol,
    executionTimeMs, success, error, bundleId
);

// Get accuracy report
const stats = tracker.getStats();
tracker.printReport();
```

---

## 3. Comparison Matrix

| Feature | yogurt/src/sim | yogurt_bot/simulation |
|---------|----------------|----------------------|
| CPMM Math | Complete | Complete |
| CLMM Math | Full tick traverse | Single-tick approx + fallback |
| DLMM Math | Full bin traverse | Bin traverse + reserve fallback |
| Arbitrage Orchestration | None | `simulateArbitrage()` |
| Optimal Sizing | None | Binary search (40 iterations) |
| Confidence Scoring | None | 0.99 CPMM, 0.85-0.92 CL |
| SimGate Pattern | None | Full implementation |
| Pool State Builder | None | Full with cache integration |
| Accuracy Tracking | None | Full with venue/confidence breakdown |
| RPC Fallback | None | Configurable |
| Tip Calculation | None | Dynamic with multipliers |
| Slippage Bounds | None | Configurable tolerance |

---

## 4. What yogurt is Missing

### 4.1 Arbitrage Simulation Layer
yogurt has the math modules but lacks the orchestration layer to:
- Combine buy + sell into single arb simulation
- Track intermediate token amounts
- Calculate net profit after all fees

### 4.2 Optimal Size Discovery
yogurt cannot currently answer: "Given pools A and B, what trade size maximizes profit?"

The binary search in yogurt_bot:
- Uses 40 iterations for ~1 trillion precision
- Checks gradient to determine search direction
- Handles edge cases (zero profit, insufficient liquidity)

### 4.3 Confidence-Based Decision Making
yogurt has no way to express simulation uncertainty:
- CPMM: deterministic, high confidence
- CLMM: depends on tick array completeness
- DLMM: depends on bin array completeness
- Mixed venues: highest uncertainty

### 4.4 Cache-to-Simulation Bridge
yogurt has caches (`src/cache/`) but no standardized path to simulation.
yogurt_bot's `poolStateBuilder.ts` provides this bridge.

### 4.5 Prediction Validation
yogurt cannot currently measure simulation accuracy.
`simAccuracyTracker.ts` provides:
- Per-venue accuracy metrics
- Confidence bucket analysis
- Continuous improvement data

---

## 5. Code Ready to Port

### Priority 1: Arbitrage Orchestration
Port `simulateArbitrage()` from `localSimulator.ts`:
- Wraps buy + sell simulation
- Calculates profit metrics
- Assigns confidence scores

### Priority 2: Optimal Size Binary Search
Port `findOptimalArbAmount()` and `findOptimalCPMMAmount()`:
- Binary search with gradient checking
- CPMM-optimized path for homogeneous pairs

### Priority 3: SimGate Validation Layer
Port `arbSimGate.ts`:
- Configurable thresholds
- Tip calculation
- Slippage bounds
- Stats tracking

### Priority 4: Pool State Builder
Port `poolStateBuilder.ts`:
- Adapt to yogurt's cache structure
- Maintain unified `PoolState` interface

### Priority 5: Accuracy Tracker
Port `simAccuracyTracker.ts`:
- Integrate with execution pipeline
- Enable continuous accuracy measurement

---

## 6. Integration Recommendations

### Step 1: Define Unified PoolState
Create `yogurt/src/sim/types.ts` with PoolState interface matching yogurt_bot.

### Step 2: Create Arb Simulation Layer
```typescript
// yogurt/src/sim/arb.ts
export function simulateArbitrage(
    buyPool: PoolState,
    sellPool: PoolState,
    amountIn: bigint,
    tickArrays?: Map<string, TickArray[]>,
    binArrays?: Map<string, BinArray[]>
): ArbSimResult;
```

### Step 3: Add Binary Search
```typescript
// yogurt/src/sim/optimal.ts
export function findOptimalAmount(
    buyPool: PoolState,
    sellPool: PoolState,
    maxAmount: bigint,
    ...
): OptimalSizeResult | null;
```

### Step 4: Create Snapshot-to-Sim Bridge
Adapt yogurt's `SnapshotBuilder` to produce `PoolState` objects.

### Step 5: Add SimGate Layer
Create `yogurt/src/sim/gate.ts` with validation logic.

---

## 7. Appendix: Key Constants

### From yogurt_bot

```typescript
// Minimum trade size
const MIN_TRADE_LAMPORTS = 10_000_000n;  // 0.01 SOL

// Binary search iterations
const MAX_ITERATIONS = 40;  // ~1 trillion precision

// Fee precision
const FEE_DENOMINATOR = 1_000_000n;

// CLMM math constants
const Q64 = 2n ** 64n;

// Default fees
const FEES = {
    PUMPSWAP: 0.003,      // 0.30%
    RAYDIUM_V4: 0.0025,   // 0.25%
    RAYDIUM_CLMM: 0.0025, // 0.25% default
    METEORA: 0.003,       // 0.30% default
};

// Confidence thresholds
const CONFIDENCE = {
    CPMM_EXACT: 0.99,
    CLMM_SAME: 0.90,
    DLMM_SAME: 0.92,
    MIXED: 0.85,
    NO_BIN_DATA_PENALTY: 0.9,  // multiply
};

// Tip strategy
const TIP_STRATEGY = {
    baseTip: 10_000n,              // 0.00001 SOL
    profitSharePercent: 50,        // 50% of profit
    freshPoolMultiplier: 1.5,
    highSpreadMultiplier: 1.2,
    minTip: 100_000n,              // 0.0001 SOL
    maxTip: 10_000_000n,           // 0.01 SOL
};
```

---

## 8. Conclusion

yogurt has solid simulation math but lacks the orchestration, optimization, and validation layers that yogurt_bot provides. Porting the following components would bridge this gap:

1. **`simulateArbitrage()`** - Unified buy/sell simulation
2. **`findOptimalArbAmount()`** - Binary search for profit maximization
3. **`arbSimGate.ts`** - Validation layer with configurable thresholds
4. **`poolStateBuilder.ts`** - Cache-to-sim state conversion
5. **`simAccuracyTracker.ts`** - Prediction accuracy tracking

The SimGate pattern's 90% RPC savings claim is achievable through aggressive local filtering, only falling back to RPC simulation for low-confidence scenarios or final validation before execution.

---

*Report generated: 2026-01-21*
*Paths analyzed:*
- `/home/dudesoup/code/yogurtslinger_bot/red/yogurt/src/sim/`
- `/home/dudesoup/code/yogurtslinger_bot/src/simulation/`
