# WIRING_OLD.md

**What to wire from legacy code, where it lives, how to integrate it.**

---

## Source Repositories

| Location | What's There |
|----------|--------------|
| `/home/dudesoup/code/yogurtslinger_bot/src/` | 28,771 LOC - Validated decoders (70KB raydium.ts, 49KB meteora.ts), LocalSimulator, SimGate, brain caches |
| `/home/dudesoup/code/yogurtslinger_bot/red/src/` | Dual-layer state, JitoBundleBuilder, cross-venue detection, hot path sims (validated 100% accuracy) |
| `./old_tools/executor/` | Quoters, 6 instruction builders, routing, ML logging, opportunity strategies, staleness checks |

---

## TIER 1: Jito Execution (Enables Bundle Submission)

### JitoBundleBuilder
**Source:** `/home/dudesoup/code/yogurtslinger_bot/red/src/execution/jitoBundleBuilder.ts`
**Target:** `src/execute/bundle.ts`

**What it has:**
- 8 official Jito tip accounts (load balanced)
- gRPC bundle submission to block engine
- Atomic bundle construction (trigger + arb + tip)
- Venue-specific swap data encoders:
  - `buildPumpSwapSwapData()` - disc: `66063d1201daebea`
  - `buildRaydiumV4SwapData()` - ix index 9
  - `buildRaydiumClmmSwapData()` - with sqrtPriceLimit
  - `buildMeteoraDlmmSwapData()` - disc: `235613b94ed44bd3`
- Default tip: 0.001 SOL, compute budget: 400k units

**Integration:**
```typescript
import { JitoBundleBuilder } from './jitoBundleBuilder';

const builder = new JitoBundleBuilder(config);
await builder.connect();
const result = await builder.submitArbBundle(opportunity, buyIxs, sellIxs);
// Returns: { bundleId, success, profitLamports, executionTimeMs }
```

---

### Instruction Builders (6 Venues)
**Source:** `old_tools/executor/build*.ts`
**Target:** `src/execute/builders/`

| Source File | Target | Venue | Key Pattern |
|-------------|--------|-------|-------------|
| `buildRaydiumCpmmIx.ts` (323 lines) | `builders/raydiumV4.ts` | Raydium V4 CPMM | Disk-first pool keys, 4 SDK variant fallbacks |
| `buildRaydiumClmmIx.ts` (236 lines) | `builders/raydiumClmm.ts` | Raydium CLMM | API pool metadata, tick array resolution |
| `buildMeteoraDlmmIx.ts` (136 lines) | `builders/meteoraDlmm.ts` | Meteora DLMM | Two-pass bin array (cache→refresh) |
| `buildOrcaWhirlpoolIx.ts` (98 lines) | `builders/orca.ts` | Orca Whirlpools | Readonly wallet adapter, quote→build |
| `buildLifinityIx.ts` (87 lines) | `builders/lifinity.ts` | Lifinity | Fixed discriminator, oracle fallback cascade |
| **MISSING** | `builders/pumpswap.ts` | PumpSwap | Create from JitoBundleBuilder swap data encoder |

**Key patterns to preserve:**
- Disk-first pool key loading (no SDK discovery)
- Return shape normalization (SDK version differences)
- Two-pass bin array loading (cache → refresh)
- Instruction validation before submission

**Adapt for local cache:**
```typescript
interface BuildSwapIxParams {
    pool: PoolState;           // From PoolCache
    baseVault: Uint8Array;     // From VaultCache
    quoteVault: Uint8Array;    // From VaultCache
    user: PublicKey;
    amountIn: bigint;
    minAmountOut: bigint;
    baseIn: boolean;
}

function buildSwapIx(params: BuildSwapIxParams): TransactionInstruction
```

---

## TIER 2: Local Simulation (Sub-ms Decisions)

### LocalSimulator
**Source:** `/home/dudesoup/code/yogurtslinger_bot/src/simulation/localSimulator.ts`
**Target:** `src/sim/engine.ts`

**What it has:**
- Zero-allocation CPMM simulation (<1ms)
- CLMM single-tick approximation with sqrt price math
- DLMM bin traversal
- Binary search for optimal sizing (40 iterations)
- Confidence scoring by venue mix

**Key functions:**
```typescript
simulateCPMMSwap(reserves, amountIn, feeBps) → SwapSimResult
// Formula: amountOut = reserveOut * amountInAfterFee / (reserveIn + amountInAfterFee)

simulateCLMMSwapSingleTick(sqrtPriceX64, liquidity, amountIn) → SwapSimResult
// zeroForOne: Δ(1/√P) = Δx / L, then Δy = L × (√P - √P_new)

simulateDLMMSwap(bins, activeId, binStep, amountIn) → SwapSimResult
// Bin price: (1 + binStep/10000)^binId, traverses bins until input exhausted

findOptimalCPMMAmount(buyPool, sellPool, maxInput) → OptimalSizeResult
// Binary search with gradient-based optimization
```

**Confidence levels:**
- CPMM + CPMM: 0.99 (exact math)
- Same venue type: 0.90-0.92
- Mixed venues: 0.85
- No bin data: ×0.9 multiplier

---

### SimGate Pattern (90% RPC Savings)
**Source:** `/home/dudesoup/code/yogurtslinger_bot/src/simulation/arbSimGate.ts`
**Target:** `src/sim/gate.ts`

**What it does:**
- Local simulation first (< 1ms)
- Only calls RPC if confidence < threshold (0.85)
- Tracks local vs RPC accuracy for calibration

**Config:**
```typescript
interface SimGateConfig {
    minNetProfitBps: 20;
    minNetProfitLamports: 50_000n;
    maxPriceImpactBps: 200;
    slippageTolerance: 0.02;
    minConfidence: 0.80;
    useRpcFallback: false;  // For 100% local mode
}
```

**SimGateResult:**
```typescript
{
    approved: boolean;
    optimalAmountIn: bigint;
    expectedProfitLamports: bigint;
    expectedProfitBps: number;
    minTokensOut: bigint;  // Slippage-adjusted
    minSolOut: bigint;
    suggestedTipLamports: bigint;
    confidence: number;
    simulationTimeMs: number;
    method: "local" | "rpc" | "rejected";
}
```

---

### Hot Path Simulators
**Source:** `/home/dudesoup/code/yogurtslinger_bot/red/src/sim/hotPathSim.ts`
**Target:** Enhance `src/sim/math/`

**Validated to 100% accuracy against on-chain vault deltas:**
- PumpSwap: 25bps fee on output (sell) / input (buy) with ceiling adjustment
- Raydium V4: Variable fee from pool state numerator/denominator
- CLMM: Pre-cached tick arrays for traversal
- DLMM: Bin map traversal with volatility tracking

---

## TIER 3: Arb Detection (Finding Opportunities)

### Cross-Venue Arb Detector
**Source:** `/home/dudesoup/code/yogurtslinger_bot/red/src/detection/crossVenueArbDetector.ts`
**Target:** `src/arb/detector.ts`

**What it does:**
```typescript
detectOpportunity(baseMint, quoteMint, inputAmount) → ArbOpportunity | null
// 1. Gets current prices from all venues (from cache)
// 2. Finds cheapest buy, most expensive sell
// 3. Simulates full path locally
// 4. Returns if profit > threshold
```

**ArbOpportunity type:**
```typescript
interface ArbOpportunity {
    buyVenue: VenueId;
    buyPool: string;
    sellVenue: VenueId;
    sellPool: string;
    inputAmount: bigint;
    expectedProfit: bigint;
    profitBps: number;
    confidence: number;  // 95%+ with validated simulators
    expirySlot: number;
}
```

**Config:**
```typescript
{
    minProfitLamports: 10_000_000n,    // 0.01 SOL
    minProfitBps: 10,                   // 0.1%
    gasBudgetLamports: 5_000n,
    tipBudgetLamports: 1_000_000n,
    maxInputLamports: 5_000_000_000n,   // 5 SOL max
    minSpreadBps: 20,                   // 0.2% minimum spread
}
```

---

### Two-Phase Detection Strategy
**Source:** `old_tools/executor/opportunity/cross_venue_arb_tracker.cjs`
**Target:** `src/arb/phaseDetector.ts`

**Phase 1 - Listing Snipe:**
- Detect when PumpSwap token first lists on external DEX
- Maximum spread opportunity, fastest execution wins

**Phase 2 - Sustained Arbitrage:**
- High volume velocity (trades creating divergence)
- High volatility (price swings = spread opportunities)
- Liquidity imbalance (thin side = easier to arb)
- Trade clustering (burst on one, other stale)

**State machine:**
```
WATCHING → ACTIVE (multi-venue) → COOLING (low activity) → remove
```

**Scoring system:**
```typescript
spreadScore = Math.min(spread_bps / 100, 10);      // Primary
volumeScore = Math.min(velocity / 5, 5);           // Active interest
volatilityScore = Math.min(volatility / 2, 5);     // More spreads
liquidityScore = Math.min(liquidity / 1, 5);       // Depth needed
freshnessScore = isStale ? -3 : 2;                 // Price staleness penalty
```

---

### Fragmentation Tracker
**Source:** `/home/dudesoup/code/yogurtslinger_bot/src/brain/fragmentationTracker.ts`
**Target:** Enhance `src/cache/lifecycle.ts`

**Events to emit:**
- `GRADUATION` - Token first appears on PumpSwap
- `NEW_FRAGMENTATION` - Token goes 1→2 venues (HOT!)
- `VENUE_ADDED` - Token already fragmented, another venue added

**O(1) lookup using Set:**
```typescript
isFragmented(tokenMint): boolean
getRecentlyFragmented(maxAgeMs): string[]  // Last 60s
```

---

## TIER 4: Fee Fixes (Prevents Bad Trades)

### PumpSwap Fee
**Bug found:** Code uses 25bps, should be **30bps**

**Source:** `old_tools/executor/opportunity/validate_fragmentation_strategy.mjs`
**Target:** `src/sim/math/constantProduct.ts`

```typescript
// WRONG:
const PUMPSWAP_FEE_BPS = 25;

// CORRECT:
const PUMPSWAP_FEE_BPS = 30;  // 20 LP + 5 protocol + 5 creator
```

---

### Meteora Fee Formula
**Note:** Review `old_tools/executor/opportunity/validate_fragmentation_strategy.mjs` for fee calculation patterns.

**Source:** `old_tools/executor/opportunity/validate_fragmentation_strategy.mjs`
**Target:** `src/sim/math/dlmm.ts`

**Fields to investigate (from pool account):**
- `baseFactor` @ offset 8 (u16)
- `volatilityAccumulator` @ offset 72 (u32)
- `variableFeeControl` @ offset 16 (u32)

**Needs validation:** Compare simulated fees against actual on-chain swap outputs before implementing.

---

## TIER 5: State Management (Cache Architecture)

### Dual-Layer State (Confirmed + Speculative)
**Source:** `/home/dudesoup/code/yogurtslinger_bot/red/src/state/speculativeState.ts`
**Target:** Enhance `src/cache/` with speculative layer

**Architecture:**
- Layer 1: Confirmed state (gRPC) = source of truth
- Layer 2: Pending transactions (ShredStream) = prediction layer
- Never mixes predictions into confirmed state

**Key methods:**
```typescript
addPendingTransaction(tx: PendingTransaction): void
confirmTransaction(signature: string, slot: number): void
failTransaction(signature: string): void
getSpeculativeState(pubkey: string): AccountState | null
```

---

### Staleness Checks
**Source:** `old_tools/executor/util/slot_staleness.ts`
**Target:** `src/snapshot/staleness.ts`

**Multi-layer staleness:**
```typescript
interface AmmSnapshotMeta {
    ts: number;        // Publisher timestamp (ms)
    slot?: number;     // Publisher slot
    venue: string;
    ammId: string;
}

function staleReason(snapshot: AmmSnapshotMeta, clock: { slot, ts }, now: number): string | null {
    // Age check
    const ageMs = now - snapshot.ts;
    if (ageMs > MAX_AGE_MS) return `age_ms>${MAX_AGE_MS}`;

    // Slot lag check
    const lag = clock.slot - snapshot.slot;
    if (lag > MAX_LAG_SLOTS) return `slot_lag>${MAX_LAG_SLOTS}`;

    return null;  // Fresh
}
```

**Config (env vars):**
- `AMM_SLOT_MAX_LAG`: 12 slots default
- `AMM_SNAPSHOT_MAX_AGE_MS`: 5000ms default

---

## TIER 6: Route Discovery (Multi-Hop Paths)

### Backtracking Route Enumeration
**Source:** `old_tools/executor/routing/graph.ts`
**Target:** `src/routing/graph.ts`

**Algorithm:**
```typescript
enumerateRoutePlans(nodes, options): RoutePlan[]
// Backtracking DFS with:
// - No AMM-to-same-AMM edges
// - Optional Phoenix count limit (maxPhoenix)
// - Budget enforcement (maxRoutes cap at 20,000)
// - Deduplication by path + node chain
```

**Config:**
```typescript
{
    maxLegs: 4,        // Start conservative (2-4 hops)
    maxRoutes: 1000,   // Budget cap
    maxPhoenix: 1,     // Optional Phoenix count limit
}
```

**Route key for caching:**
```typescript
function makeRouteKey(legs: Leg[]): string {
    return `${path}|${srcKey}|${dstKey}`;
    // Example: "PHX->AMM|phx:market123|amm:raydium:pool456"
}
```

---

## TIER 7: ML Feature Collection (Learning)

### Feature Sink
**Source:** `old_tools/executor/edge/feature_sink.ts`
**Target:** `src/telemetry/features.ts`

**40+ features per decision:**
```typescript
interface DecisionFeatures {
    // Market state
    ts: number;
    symbol: string;
    path: string;

    // Prices
    buyPx: number;
    sellPx: number;
    spreadBps: number;

    // Simulation
    ammEffPx: number;
    priceImpactBps: number;

    // Decision
    wouldTrade: boolean;
    expectedPnl: number;
    confidence: number;

    // Chain state
    tps: number;

    // ... 30+ more
}
```

**Output:** JSONL to `data/features/edge_features-YYYYMMDD.jsonl`

---

### ML Event Schema
**Source:** `old_tools/executor/ml_logs/ml_schema.ts`
**Target:** `src/telemetry/ml.ts`

| Event | Purpose | Key Fields |
|-------|---------|------------|
| `edge_snapshot` | Decision-time features | symbol, path, buy_px, sell_px, edge_bps |
| `would_trade` | Positive label | expected_pnl, reason |
| `would_not_trade` | Negative label | reason |
| `sim_result` | RPC latency sample | rpc_sim_ms, blocked |
| `submitted_tx` | Execution submission | ix_count, cu_limit, tip_lamports |
| `landed` | Fill confirmation | slot, conf_ms, fill_px, filled_base |

---

## Validated Decoders (Production-Ready)

### Already Validated in Legacy Code

| Venue | File | Validation Status |
|-------|------|-------------------|
| Raydium V4 | `src/decoders/raydium.ts` (70KB) | 51/51 offsets validated |
| Raydium CLMM | Same file | 425/425 pools validated |
| Meteora DLMM | `src/decoders/meteora.ts` (49KB) | 70/70 fee formulas validated |
| PumpSwap | `src/decoders/pumpswap.ts` | Discriminator verified |
| Token-2022 | `src/decoders/raydium.ts` | TLV byte-scan validated (HDog @ 1410 bps) |

**Key validated offsets:**
- CLMM discriminator: `f7ede3f5d7c3de46`
- DLMM LbPair discriminator: `210b3162b565b10d`
- DLMM BinArray discriminator: `5c8e5cdc059446b5`
- TickArray PDA uses **BIG ENDIAN** for index (not LE!)
- BinArray index uses **signed i64 LE** encoding

**Important decoder findings:**
- Raydium V4 fees CAN be 0% (found on-chain) - handle division by zero
- CLMM status === 0 means ACTIVE (different from V4 status === 6)
- OpenOrders contribution = 0% across all tested pools (safe to ignore)

---

## Additional Valuable Components

### Brain Caches (O(1) Lookups)
**Source:** `/home/dudesoup/code/yogurtslinger_bot/src/brain/`

| Component | Purpose | Integration |
|-----------|---------|-------------|
| `MarketCache` | All pool states, O(n) filtering | Central state container |
| `TokenAccountCache` | Vault balances, O(1) lookups | Already similar in VaultCache |
| `BinArrayCache` | Meteora liquidity depth | Slippage estimation |
| `FragmentationTracker` | Multi-venue tracking | Opportunity detection |
| `OpportunityScanner` | Price-based arb detection | Event-driven signals |

### Position & Capital Management
**Source:** `/home/dudesoup/code/yogurtslinger_bot/src/execution/positionSizer.ts`

```typescript
interface CapitalConfig {
    totalCapitalLamports: 8_400_000_000n;  // 8.4 SOL
    maxPerTradePercent: 0.25;              // 25% max per trade
    maxConcurrentTrades: 4;
    minTradeLamports: 100_000_000n;        // 0.1 SOL min
}

// Functions:
calculateTradeSize(config, liquidity): SizeResult
openPosition(position): void
closePosition(id): OpenPosition | undefined
getAvailableCapital(config): bigint
```

### Execution Guards
**Source:** `old_tools/executor/execute/`

| Guard | Purpose | Pattern |
|-------|---------|---------|
| `sendGate.ts` | Funding check | Min SOL balance before broadcast |
| `preflight.ts` | Account validation | SOL balance, ATA existence |
| `rpcSim.ts` | Simulation wrapper | Extract units consumed, classify errors |
| `live.ts` | EV gates | Pre-send + post-sim profit checks |

---

## Quick Wins (Minimal Effort)

### 1. Fee Fixes (10 minutes)
```typescript
// src/sim/math/constantProduct.ts
- const PUMPSWAP_FEE_BPS = 25;
+ const PUMPSWAP_FEE_BPS = 30;

// src/sim/math/dlmm.ts
// Add baseFactor read at offset 8
// Implement correct fee formula
```

### 2. Staleness Check (30 minutes)
```typescript
// src/cache/ammConfig.ts - Add to commitAccountUpdate()
if (staleReason(snapshot, clock, now) !== null) {
    return false;  // Reject stale update
}
```

### 3. Speculative State Flag (1 hour)
```typescript
// src/cache/pool.ts - Add speculative layer
interface PoolCacheEntry {
    confirmed: PoolState;
    speculative?: PoolState;  // From pending TXs
}
```

---

## Integration Order

1. **Fee fixes** — Prevents bad trades (10 min)
2. **Instruction builders** — Enables execution (2-4 hrs)
3. **JitoBundleBuilder** — Enables Jito submission (1-2 hrs)
4. **LocalSimulator** — Enables sub-ms decisions (2-4 hrs)
5. **SimGate** — 90% RPC reduction (1-2 hrs)
6. **Cross-venue detector** — Finds opportunities (2-4 hrs)
7. **Two-phase strategy** — Smarter entry timing (1-2 hrs)
8. **Route discovery** — Multi-hop paths (2-4 hrs)
9. **ML features** — Learning from decisions (2-4 hrs)

---

## DO NOT Modify (FROZEN)

```
src/cache/commit.ts
src/cache/lifecycle.ts
src/cache/pool.ts
src/cache/vault.ts
src/cache/tick.ts
src/cache/bin.ts
src/decode/**/*.ts
```

Cache is trusted. Integration works WITH cache, not around it.

---

## Verification Commands

```bash
# After each integration:
pnpm typecheck                    # Must pass
grep -r "connection\." src/       # Zero RPC in hot path
pnpm evidence 60                  # Quick capture test

# For fee validation:
sqlite3 data/evidence/capture.db "
SELECT venue,
       AVG(ABS(simulated - actual) / actual * 100) as avg_error_pct
FROM parsed_swaps
WHERE actual_output_amount IS NOT NULL
GROUP BY venue;
"
# Target: <0.1% for all venues
```

---

## File Reference

| Legacy Path | Purpose |
|-------------|---------|
| `yogurtslinger_bot/src/brain/` | MarketCache, FragmentationTracker, TokenAccountCache, BinArrayCache |
| `yogurtslinger_bot/src/simulation/` | LocalSimulator, arbSimGate, poolStateBuilder, simAccuracyTracker |
| `yogurtslinger_bot/src/execution/` | jitoBundle, swapBuilder, positionSizer, profitSimulator |
| `yogurtslinger_bot/src/decoders/` | Validated decoders (70KB raydium.ts, 49KB meteora.ts) |
| `red/src/state/` | SpeculativeStateManager, HotPathCache, UnifiedPoolRegistry |
| `red/src/detection/` | CrossVenueArbDetector, OpportunityDetector |
| `red/src/execution/` | JitoBundleBuilder with all swap data encoders |
| `red/src/sim/` | Hot path simulators (validated 100% accuracy) |
| `red/src/pipeline/` | ArbPipeline orchestrator, FractureArbScanner |
| `old_tools/executor/edge/` | Quoters (CLMM, DLMM, AMM), feature sink, replay |
| `old_tools/executor/util/` | Raydium helpers (25KB), Meteora DLMM, slot staleness |
| `old_tools/executor/routing/` | Backtracking route enumeration, pool graph |
| `old_tools/executor/registry/` | Pair configs, multi-venue per-pool freshness |
| `old_tools/executor/opportunity/` | Two-phase strategy, fee validation scripts |
| `old_tools/executor/build*.ts` | 6 venue instruction builders (1,000+ lines total) |
| `old_tools/executor/ml_logs/` | ML schema, event writer, session logger |
| `old_tools/executor/runtime/` | Telemetry, heartbeat metrics |
| `old_tools/executor/execute/` | maybeExecute, submit, sendGate, rpcSim |
| `old_tools/executor/tx/` | Transaction builder, preflight checks |

---

## ROOT-LEVEL ASSETS (Not in src/)

### ShredStream Proxy (Rust)
**Location:** `/home/dudesoup/code/yogurtslinger_bot/shredstream-proxy/`
**Status:** Production-quality Jito Labs implementation

**What it does:**
- Receives shreds from Jito Block Engine via gRPC
- Reed-Solomon FEC reconstruction (shreds → entries)
- Forwards via UDP unicast/multicast + gRPC SubscribeEntries

**Already integrated:**
- `src/ingest/shred.ts` consumes `SubscribeEntries()` stream
- Connects to `127.0.0.1:11000` by default

**Gaps for bundle submission:**
| Component | Status | Effort |
|-----------|--------|--------|
| Jito auth token management | Not in yogurt | LOW |
| Bundle assembly logic | Not in yogurt | MEDIUM |
| `SendBundleRequest` submission | Not in yogurt | LOW |
| Bid/commission strategy | Not in yogurt | HIGH |

**Endpoints (from CLI):**
```bash
--block-engine-url https://mainnet.block-engine.jito.wtf
--auth-keypair ~/.solana/my-keypair.json
--grpc-service-port 9999
--dest-ip-ports 127.0.0.1:8001
```
---

### Evidence Database (18GB)
**Location:** `data/evidence/capture.db`

**Key Tables (latest session):**
| Table | Rows | Purpose |
|-------|------|---------|
| `mainnet_updates` | 1.87M | Raw gRPC account states |
| `cache_traces` | 1.47M | Cache mutations + rejections |
| `pending_shreds` | 4.8M | ShredStream pending TXs |
| `mainnet_txs` | 614K | Confirmed transactions |
| `parsed_swaps` | 297K | Decoded swaps (100% success) |
| `topology_events` | 14.5K | Lifecycle transitions |
| `frozen_topologies` | 4.8K | Dependency snapshots |

**Parsed Swaps by Venue:**
- PumpSwap: 287,760 (96.7%)
- Raydium CLMM: 7,089 (2.4%)
- Raydium V4: 1,967 (0.7%)
- Meteora DLMM: 693 (0.2%)

---

### Critical Hotfix Applied
**File:** `HOTFIX_BIGINT_BITMAP_HANG.md`

**Bug:** Meteora DLMM `binArrayBitmap[16]` stored as signed i64. When fully populated (0xFFFF...), reads as `-1n`. Kernighan bit-counting loop hangs on negative BigInt.

**Fix (Applied):**
```typescript
const U64_MASK = 0xFFFFFFFFFFFFFFFFn;
const asU64 = (x: bigint): bigint => x & U64_MASK;
```

**Rule:** Any `BigInt64Array` or `getBigInt64()` MUST mask to unsigned before bitwise ops.

---

## Hardware (Available but Unused)

| Resource | Spec | Current Use | Future Use |
|----------|------|-------------|------------|
| GPU | RTX 5070 12GB CUDA 13.0 | 0% | GPU route discovery |
| CPU | Threadripper 7960X 24-core | Low | Current pipeline |
| RAM | 503GB | Low | Extended state caching |

---

## Needs to be Audited/Validated

Items found during code review that require validation against on-chain data or regression tests before determining correctness.

### DLMM Fee Formula Discrepancy

Two different divisors found in yogurt codebase:

| File | Line | Formula |
|------|------|---------|
| `src/sim/math/fees.ts` | 141 | `(baseFactor * binStepBig) / 100n` |
| `src/sim/math/dlmm.ts` | 270 | `(baseFactor * binStepBig) / 10000n` |

**Unknown:** Which matches actual Meteora DLMM on-chain behavior. Need to run regression against captured swaps.

### ShredStream Silent Error Handling

`src/ingest/shred.ts:144-146` silently discards corrupted entries:
```typescript
} catch {
    // Silent fail on corrupted data
}
```

**Unknown:** How often this occurs, whether it affects data integrity. Need to add metrics/logging to measure.

### gRPC Start Slot Freshness

`src/ingest/grpc.ts:569-574` captures subscription start slot from first response but doesn't validate it's recent.

**Unknown:** Whether this causes convergence issues in practice. Need to check against evidence captures.

### Proto Reload on Reconnect

`src/ingest/grpc.ts` calls `loadProto()` inside `connect()`, which runs on every reconnect.

**Unknown:** Performance impact. May be negligible or may matter under reconnect storms.

### Vault Subscription Queue

`src/ingest/grpc.ts` `subscribeVaults()` has no max queue size on `pendingVaults` Set.

**Unknown:** Whether this causes memory issues in practice with high pool discovery rate.

### Simulation Math Differences (red/src vs red/yogurt/src)

Code review found different implementations between legacy `red/src/sim/` and current `red/yogurt/src/sim/math/`. Specific differences not validated.

**Unknown:** Which implementations are correct. Need regression tests comparing both against on-chain swap outputs.

---

## EXPANDED REPOSITORY ANALYSIS (2026-01-21)

### Current Yogurt/Src Architecture (57 files, 18,418 LOC)

| Component | Files | LOC | Status |
|-----------|-------|-----|--------|
| Cache | 12 | 2,400 | 95% complete |
| Decode | 16 | 2,200 | 90% complete |
| Simulation | 7 | 1,500 | 90% complete |
| Handlers | 4 | 1,200 | 90% complete |
| Topology | 4 | 1,000 | 90% complete |
| Ingest | 3 | 800 | 85% complete |
| Pending | 4 | 800 | 85% complete |
| Execute | 4 | 600 | 60% complete |
| Snapshot | 3 | 400 | 85% complete |
| Types | 3 | 400 | Complete |
| Instrument | 3 | 400 | 85% complete |

### Gate Requirements Framework

| Phase | Gate | Requirement | File |
|-------|------|-------------|------|
| Phase 1 | WBS-G1 | p99 < 100μs, zero drops | `src/ingest/grpc.ts` |
| Phase 2 | WBS-G2 | Decode success ≥99.5% | `src/decode/account.ts` |
| Phase 3 | WBS-G3 | Cache vs RPC match 100% | `src/snapshot/builder.ts` |
| Phase 5 | WBS-G5 | Sim accuracy ±0.1% | `src/sim/math/*` |
| Phase 8 | WBS-G8 | Bundles pass preflight 100% | `src/execute/bundle.ts` |

---

## Red/Src Legacy Components (20,510 LOC)

### Production-Ready Modules

| Component | File | Lines | Status |
|-----------|------|-------|--------|
| JitoBundleBuilder | `red/src/execution/jitoBundleBuilder.ts` | 442 | ✅ Production |
| HotPathSim | `red/src/sim/hotPathSim.ts` | 432 | ✅ Validated ±0.1% |
| CrossVenueDetector | `red/src/detection/crossVenueArbDetector.ts` | 474 | ✅ Tested |
| PoolRegistry | `red/src/state/unifiedPoolRegistry.ts` | 329 | ✅ Proven |
| SpeculativeState | `red/src/state/speculativeState.ts` | 500 | ⚠️ Needs wiring |
| ArbPipeline | `red/src/pipeline/arbPipeline.ts` | 496 | ⚠️ Needs wiring |
| OpportunityDetector | `red/src/detection/opportunityDetector.ts` | 654 | ✅ Tested |

### Validated Simulators (red/src/sim/)

| Venue | File | Validation |
|-------|------|------------|
| PumpSwap | `pumpswapSim.ts` | 25/25 vault delta matches |
| Raydium V4 | `raydiumV4Sim.ts` | Effective reserves validated |
| Raydium CLMM | `raydiumCLMMSim.ts` | Tick traversal verified |
| Meteora DLMM | `meteoraDLMMSim.ts` | Bin traversal verified |

### State Management Architecture

```
Layer 1: CONFIRMED STATE (Yellowstone gRPC)
         → Source of truth, NEVER modified by speculative data

Layer 2: SPECULATIVE STATE (PendingTransactionQueue)
         → Fed by ShredStream
         → Transactions applied in deterministic order

Layer 3: OPPORTUNITY DETECTION
         → Simulate pending swap on predicted state
         → Build & submit bundle if profitable
```

---

## YogurtSlinger Bot Main (28,771 LOC)

### Validated Decoder Summary

| Decoder | File | LOC | Validation |
|---------|------|-----|------------|
| Raydium (V4+CLMM) | `src/decoders/raydium.ts` | 1,642 | 425/425 pools, 51/51 offsets |
| Meteora DLMM | `src/decoders/meteora.ts` | 1,256 | 70/70 pools, 280/280 PDAs |
| PumpSwap | `src/decoders/pumpswap.ts` | 176 | Fixed fee structure verified |

### Brain Caches (O(1) Lookups)

| Cache | File | Purpose |
|-------|------|---------|
| MarketCache | `src/brain/marketCache.ts` (731 LOC) | Pool state tracking |
| BinArrayCache | `src/brain/binArrayCache.ts` (350 LOC) | Meteora bin liquidity |
| TokenAccountCache | `src/brain/tokenAccountCache.ts` (177 LOC) | Vault balances |
| FragmentationTracker | `src/brain/fragmentationTracker.ts` (362 LOC) | Cross-venue detection |
| Pricing | `src/brain/pricing.ts` (410 LOC) | Spot price calc |

### Execution Engine Components

| Component | File | Purpose |
|-----------|------|---------|
| ExecutionEngine | `src/execution/executionEngine.ts` (1,273 LOC) | SimGate + validation |
| PositionSizer | `src/execution/positionSizer.ts` (336 LOC) | Capital management |
| SwapBuilder | `src/execution/swapBuilder.ts` (697 LOC) | Instruction builders |
| JitoBundle | `src/execution/jitoBundle.ts` (646 LOC) | Bundle construction |
| ProfitSimulator | `src/execution/profitSimulator.ts` (420 LOC) | Spread/fee calc |

---

## Old_tools/Executor Analysis

### Opportunity Detection Files

| File | Lines | Purpose |
|------|-------|---------|
| `opportunity_tracker.cjs` | 978 | Multi-venue pool tracking |
| `cross_venue_arb_tracker.cjs` | 826 | Two-phase arb detection |
| `alpha_mev_edge_research_v2.cjs` | 846 | Jito alpha mapping |
| `validate_fragmentation_strategy.mjs` | 250+ | Fee validation |

### Two-Phase Detection Strategy

**Phase 1 - Listing Snipe:**
- Detect PumpSwap token first appearing on external DEX
- Maximum spread, fastest execution wins

**Phase 2 - Sustained Arbitrage:**
- Monitor multi-venue tokens
- Scoring: spread + volume + volatility + liquidity + freshness

---

## GitHub MCP: DewdSoup/mev Repository

### Repository Structure (Monorepo)

```
packages/
├── core       - Config management
├── amms       - AMM adapters (Raydium, Orca, Meteora)
├── executor   - Transaction building
├── jito       - Bundle submission
├── phoenix    - Phoenix integration
├── router     - Route enumeration
├── risk       - Risk management
├── solana     - Blockchain utilities
├── storage    - Data persistence
└── rpc-facade - RPC abstraction

services/
└── arb-mm     - Main arbitrage engine
```

### Risk Guard System

| Guard | Env Variable | Purpose |
|-------|-------------|---------|
| Per-minute notional | `GUARD_PER_MIN_NOTIONAL_QUOTE` | Rate limiting |
| Consecutive fails | `GUARD_CONSEC_FAILS_PATH` | Path circuit breaker |
| Error burst | `GUARD_ERROR_BURST_MAX` | Error rate limiting |
| Chain TPS | `GUARD_MIN_CHAIN_TPS` | Congestion throttling |

### Jito Integration Pattern

```typescript
// Dynamic tip calculation
share = alpha * evAbsUsd + beta * slotLoad + gamma
tip = clamp(share, floor, maxLamports)
```

---

## Simulation Math Comparison

### CPMM Formula Comparison

| Codebase | Formula | Status |
|----------|---------|--------|
| red/yogurt | `dy = (y * dx * (10k - fee)) / (x * 10k + dx * (10k - fee))` | ✅ Unit tested |
| red/src | Asymmetric: OUTPUT fee on SELL, INPUT fee on BUY | ✅ Vault delta verified |
| root | Approximation: `amountAfterFee * (FEE_DENOM - feeNum) / FEE_DENOM` | ⚠️ Float precision loss |

### CLMM Implementation Status

| Aspect | red/yogurt | red/src |
|--------|------------|---------|
| Tick Multipliers | 2 entries (incomplete) | 19 entries (proper) |
| Tick Traversal | Incomplete | Full binary search |
| Fee Calculation | Missing | 1M denominator |

**Action:** Copy full tick multiplier table from red/src to red/yogurt.

### DLMM Fee Discrepancy

| File | Divisor | Domain |
|------|---------|--------|
| red/yogurt/src/sim/math/dlmm.ts | `/10000n` | Basis points |
| red/src/sim/meteoraDLMMSim.ts | `/1e17` | 1e17 domain |

**Action:** Regression test against 100+ actual swaps to validate.

---

## Instruction Builder Discriminators

### All Venues (Verified)

| Venue | Discriminator | Layout |
|-------|---------------|--------|
| PumpSwap BUY | `[102, 6, 61, 18, 1, 218, 235, 234]` | `[disc:8][amount_in:u64][min_out:u64]` |
| PumpSwap SELL | `[51, 230, 133, 164, 1, 127, 131, 173]` | `[disc:8][amount_in:u64][min_out:u64]` |
| Raydium V4 | `9` (native index) | `[ix:u8][amount:u64][min:u64]` |
| Raydium CLMM | `0x2b04ed0b1ac91e62` | `[disc:8][amount:u64][thresh:u64][sqrt:u128][dir:u8]` |
| Meteora DLMM | `0x235613b94ed44bd3` | `[disc:8][amount_in:u64][min_out:u64]` |

---

## Pending State Architecture (S4.5)

### Queue Implementation

```typescript
interface PendingTxEntry {
    signature: Uint8Array;
    slot: number;
    decoded: DecodedTx;
    rawUpdate: TxUpdate;
    receivedAtNs: bigint;
    deltas?: PoolDelta[];
}

// Config
maxSize: 10,000
expirationSlots: 150 (~60 seconds)
expirationMs: 60,000
```

### Speculative Replay Flow

```
Confirmed Cache State
        +
Pending TX Queue (sorted by slot, signature)
        ↓
Sequential Delta Application (order-dependent CPMM)
        ↓
Speculative Reserves (read-only overlay)
```

**Critical:** CPMM swaps are order-dependent - cannot sum deltas.

---

## ShredStream Proxy (Rust)

### Proto Definitions

| Proto | Purpose |
|-------|---------|
| `shredstream.proto` | Entry subscription |
| `block_engine.proto` | Validator packet stream |
| `bundle.proto` | Bundle submission |
| `searcher.proto` | Searcher API |

### Key RPC Methods

```protobuf
service ShredstreamProxy {
  rpc SubscribeEntries(SubscribeEntriesRequest) returns (stream Entry);
}

message Entry {
  uint64 slot = 1;
  bytes entries = 2;  // Serialized Vec<solana_entry::Entry>
}
```

---

## Capital & Position Management

### Configuration

```typescript
interface CapitalConfig {
    totalCapitalLamports: 8_400_000_000n;  // 8.4 SOL
    maxPerTradeLamports: 2_100_000_000n;    // 25%
    maxPerTradePercent: 0.25;
    reservePercent: 0.10;
    minTradeLamports: 100_000_000n;         // 0.1 SOL
    maxConcurrentTrades: 4;
}
```

### Size Calculation Constraints (Applied in Order)

1. Concurrent trade slots limit
2. Reserve capital requirement (10%)
3. Per-trade limit (25% max)
4. Pool liquidity available
5. Minimum trade threshold

---

## Metrics & Telemetry

### MetricsCollector (red/yogurt)

```typescript
// Phase 1 - Ingest
accountUpdatesReceived, backpressureDrops, orderingViolations

// Phase 2 - Decode
decodeSuccessCount, decodeFailureCount, cacheSize

// Phase 4 - ALT + Pending
altHits, altMisses, pendingTxsReceived, pendingTxsDecoded

// Phase 5 - Simulation
simsExecuted, simsSucceeded, simsFailed, multiHopCount

// Phase 8 - Execution
bundlesSubmitted, bundlesLanded, bundlesFailed
```

### Audit Events (yogurtslinger_bot)

| Event | Purpose |
|-------|---------|
| DETECTION | Token/venue/spread data |
| LOCAL_SIM | Profit prediction + confidence |
| RPC_SIM | RPC ground truth |
| COMPARISON | Local vs RPC divergence |
| EXECUTION | Success/failure + P&L |

---

## Updated Integration Priority

### Phase A: Foundation (Week 1)
1. Fix CLMM tick multipliers (copy from red/src)
2. Validate DLMM fee formula via regression
3. Wire red/src simulators into yogurt interfaces

### Phase B: Execution (Week 2)
4. Implement Jito submission in `src/execute/submit.ts`
5. Wire JitoBundleBuilder from red/src
6. Add risk guards from DewdSoup/mev

### Phase C: Detection (Week 3)
7. Integrate CrossVenueArbDetector
8. Wire two-phase detection strategy
9. Add speculative state overlay

### Phase D: Optimization (Week 4)
10. Add position sizing from positionSizer.ts
11. Wire metrics/telemetry
12. Enable ML confidence tracking

---

