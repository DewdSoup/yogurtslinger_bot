# Updated Cache Strategy

## Executive Summary

This document captures the findings from a comprehensive research and analysis session aimed at solving the local cache reliability problem for MEV/arbitrage simulation. The core issue was a system crash (motherboard 0d error) caused by memory exhaustion from an over-engineered bootstrap strategy.

**Key Finding**: The existing architecture is fundamentally sound. The problem is isolated to `fullSnapshot.ts` attempting to load ALL tick/bin arrays for ALL pools at startup (~1.5GB+), exceeding V8's heap limit.

> **Correction Note (2026-01-14)**
> References to `fullSnapshot.ts` have been corrected to
> `fullSnapshot.ts` following confirmation in
> FULL_SNAPSHOT_VERIFICATION.md.
> No findings, severity assessments, or conclusions were changed.

**Recommendation**: Revert to per-pool bootstrap triggered by gRPC discovery, add gRPC convergence checks before activation, and implement LRU bounds for safety.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Research Findings](#2-research-findings)
3. [Root Cause Analysis](#3-root-cause-analysis)
4. [Current Architecture Assessment](#4-current-architecture-assessment)
5. [The Convergence Gap](#5-the-convergence-gap)
6. [Recommended Architecture](#6-recommended-architecture)
7. [Implementation Plan](#7-implementation-plan)
8. [File-by-File Impact](#8-file-by-file-impact)
9. [Memory Budget](#9-memory-budget)
10. [Validation Criteria](#10-validation-criteria)

---

## 1. Problem Statement

### Original Goal
Build a local cache that serves as the sole source of truth for MEV simulation, eliminating RPC latency during simulation while maintaining 100% accuracy with mainnet state.

### What Broke
Recent changes to implement `fullSnapshot.ts` caused:
- System crashes (motherboard 0d POST code)
- Memory exhaustion from loading all tick/bin arrays at startup
- Loss of the previously-working per-pool bootstrap strategy

### Core Concerns
1. How to guarantee RPC bootstrap data is newer than gRPC (handoff problem)
2. How to ensure pools aren't activated until cache converges with live mainnet
3. Whether tick/bin arrays must be pre-fetched or can be lazy-loaded

---

## 2. Research Findings

Six specialized research agents investigated different aspects of the problem. Key findings:

### 2.1 Industry Consensus (MEV Cache Strategies)

> "No public repository demonstrates a 100% reliable cache hydration strategy for MEV arbitrage."

The closest implementations:
- **solfi-sim** (80 stars): RPC snapshot + LiteSVM local simulation (point-in-time, no live updates)
- **Helius LaserStream**: Commercial solution with `from_slot` replay (not open source)
- **Your architecture**: More sophisticated than anything publicly available

### 2.2 Yellowstone gRPC Best Practices

The consensus pattern from `blockworks-foundation/geyser-grpc-connector`:

```typescript
// 1. Bootstrap at slot N via RPC
const bootstrapSlot = await connection.getSlot();

// 2. Start gRPC with from_slot
const stream = await grpcClient.subscribe({
  fromSlot: bootstrapSlot  // CRITICAL: prevents missing updates
});

// 3. Slot-based staleness rejection
if (update.slot < cached.slot) return;  // Reject stale
if (update.writeVersion <= cached.writeVersion) return;
```

**Critical field**: `write_version` from gRPC is monotonically increasing - use it for staleness.

### 2.3 Jito Searcher Architecture

From Jito Labs' official `mev-bot` reference implementation:

> "On startup, the bot subscribes to Geyser for all pool account changes. These 'calculator' objects are initialized and updated with the pool data from Geyser."

**Validation**: Local cache via gRPC streaming is the winning pattern used by competitive searchers.

### 2.4 AMM-Specific Caching

**Minimal state per venue:**

| Venue | Accounts Needed | Notes |
|-------|-----------------|-------|
| PumpSwap | 4 | pool + 2 vaults + globalConfig |
| Raydium V4 | 4 | pool + 2 vaults + ammConfig |
| Raydium CLMM | 5-7 | pool + 2 vaults + 1-3 tick arrays + ammConfig |
| Meteora DLMM | 4-6 | pool + 2 vaults + 1-3 bin arrays |

**Key insight**: Use bitmap to fetch only 1-3 tick/bin arrays per pool (around current price), not all 20+ initialized arrays.

### 2.5 Memory Management

**V8 Heap Limits:**
- Default: ~1.4-2GB on 64-bit systems
- Container-aware (Node 20+): 50% of container memory up to 4GB

**0d POST Code**: Indicates kernel OOM or hardware memory protection trigger.

**Solution**: Replace unbounded `Map<>` with LRU caches.

### 2.6 Snapshot Bootstrap Options

Three viable approaches for fast bootstrap:

1. **Direct Snapshot Extraction**: Parse validator snapshots with `solana-snapshot-gpa`
2. **Geyser Plugin Streaming**: Use Yellowstone gRPC with `from_slot` backfill
3. **Optimized RPC Batching**: `getMultipleAccounts` with pagination

For this project, **Option 2 (gRPC streaming)** is recommended as it's already implemented.

---

## 3. Root Cause Analysis

### The Memory Explosion

`fullSnapshot.ts` lines 468-489:

```typescript
// For EVERY CLMM pool, load ALL tick arrays
const tickArrayIndexes = getAllInitializedTickArrays(p.tickArrayBitmap, p.tickSpacing);
for (const startIndex of tickArrayIndexes) {
    tickArrayPubkeys.push({ pubkey: pda, poolPubkey: pool.pubkey, startIndex });
}

// For EVERY DLMM pool, load ALL bin arrays
const binArrayIndexes = getAllInitializedBinArrays(p.binArrayBitmap);
for (const index of binArrayIndexes) {
    binArrayPubkeys.push({ pubkey: pda, poolPubkey: pool.pubkey, index });
}
```

### Memory Math

| Component | Count | Size Each | Total |
|-----------|-------|-----------|-------|
| CLMM pools | ~3,000-5,000 | - | - |
| Tick arrays per pool | 5-50+ | ~11KB | - |
| **Total tick arrays** | ~100,000+ | ~11KB | **~1.1GB** |
| DLMM pools | ~2,000+ | - | - |
| Bin arrays per pool | 3-20+ | ~7KB | - |
| **Total bin arrays** | ~30,000+ | ~7KB | **~210MB** |
| Pools | ~10,000 | ~500B | ~5MB |
| Vaults | ~20,000 | ~165B | ~3MB |
| **TOTAL** | | | **~1.5GB+** |

This exceeds V8's default heap, causing OOM and system crash.

---

## 4. Current Architecture Assessment

### What's Solid (Keep)

| Component | File | Status |
|-----------|------|--------|
| gRPC subscription (4 programs) | `phase3.ts` | ✅ Correct |
| Per-pool RPC bootstrap | `fetchPoolDeps.ts` | ✅ Correct |
| Lifecycle state machine | `lifecycle.ts` | ✅ Correct |
| Slot-based staleness | `commit.ts` | ✅ Correct |
| `minContextSlot` for handoff | `fetchPoolDeps.ts` | ✅ Correct |
| Topology oracle | `TopologyOracleImpl.ts` | ✅ Correct |

### What's Broken (Fix)

| Component | File | Issue |
|-----------|------|-------|
| Full snapshot bootstrap | `fullSnapshot.ts` | Loads ALL tick/bin arrays → OOM |
| Unbounded caches | `tick.ts`, `bin.ts` | No max size limit |
| Activation without convergence | `TopologyOracleImpl.ts` | No gRPC confirmation check |

### What's Missing (Add)

| Component | Purpose |
|-----------|---------|
| Source tracking in cache entries | Know if data came from RPC or gRPC |
| gRPC convergence check | Only activate when gRPC confirms state |
| LRU eviction | Bound memory usage |

---

## 5. The Convergence Gap

### Current Activation Flow (Problematic)

```
Slot 1000: gRPC discovers pool P
Slot 1001: RPC fetches deps (source: 'bootstrap')
Slot 1002: tryActivate() → deps exist? YES → ACTIVATED
           ↑ PROBLEM: Pool activated with RPC-only data

Slot 1005: gRPC sends update (but pool already active with stale data)
```

### Current `tryActivate()` Checks

1. ✅ Pool is in `TOPOLOGY_FROZEN` state
2. ✅ All dependencies exist in cache
3. ✅ Has at least one real (non-virtual) tick/bin array
4. ❌ **Missing: gRPC has confirmed/overwritten RPC data**

### Required Convergence Check

> **CRITICAL**: `source === 'grpc'` alone is too strict and will deadlock activation.
>
> Some accounts (ammConfig, globalConfig) are static and may not receive gRPC updates
> for hours or days. They are still correct as bootstrapped if the RPC snapshot was
> taken at or after the gRPC subscription started.

**Correct convergence condition:**

```
dependency is valid if:
  source === 'grpc'
  OR
  (source === 'bootstrap' AND bootstrap.slot >= grpc_subscription_start_slot)
```

This preserves determinism without deadlocking activation on static accounts.

**Implementation:**

```typescript
function isDependencyValid(
    entry: CacheEntry | null,
    grpcSubscriptionStartSlot: number
): boolean {
    if (!entry) return false;

    // gRPC has confirmed this dependency
    if (entry.source === 'grpc') return true;

    // Bootstrap data is valid if taken after gRPC subscription started
    // (meaning gRPC would have sent an update if data changed)
    if (entry.source === 'bootstrap' && entry.slot >= grpcSubscriptionStartSlot) {
        return true;
    }

    return false;
}

function allDepsConverged(
    topology: FrozenTopology,
    grpcSubscriptionStartSlot: number
): boolean {
    // Vaults
    const baseVault = registry.vault.getEntry(topology.vaults.base);
    const quoteVault = registry.vault.getEntry(topology.vaults.quote);
    if (!isDependencyValid(baseVault, grpcSubscriptionStartSlot)) return false;
    if (!isDependencyValid(quoteVault, grpcSubscriptionStartSlot)) return false;

    // Tick arrays (skip non-existent/virtual)
    for (const idx of topology.requiredTickArrays) {
        if (registry.tick.isNonExistent(topology.poolPubkey, idx)) continue;
        const entry = registry.tick.getEntry(topology.poolPubkey, idx);
        if (!isDependencyValid(entry, grpcSubscriptionStartSlot)) return false;
    }

    // Bin arrays (skip non-existent/virtual)
    for (const idx of topology.requiredBinArrays) {
        if (registry.bin.isNonExistent(topology.poolPubkey, idx)) continue;
        const entry = registry.bin.getEntry(topology.poolPubkey, idx);
        if (!isDependencyValid(entry, grpcSubscriptionStartSlot)) return false;
    }

    // AmmConfig (often static - this is where strict 'grpc' check would deadlock)
    if (topology.ammConfigPubkey) {
        const entry = registry.ammConfig.getEntry(topology.ammConfigPubkey);
        if (!isDependencyValid(entry, grpcSubscriptionStartSlot)) return false;
    }

    return true;
}
```

**Why this works:**
- `minContextSlot` in RPC calls already ensures bootstrap data is not older than discovery
- If bootstrap.slot >= grpcSubscriptionStartSlot, gRPC would have sent an update if data changed
- Static accounts (ammConfig) don't block activation unnecessarily
- Dynamic accounts (vaults, tick arrays) will typically be confirmed by gRPC quickly

### Correct Activation Flow (After Fix)

```
Slot 1000: gRPC discovers pool P → lifecycle.discover(P)
Slot 1001: fetchPoolDeps(P) → RPC gets deps (source: 'bootstrap')
           → freezeTopology(P) → TOPOLOGY_FROZEN
           → tryActivate(P) → deps exist BUT source !== 'grpc'
           → NOT activated (waiting for gRPC confirmation)

Slot 1005: gRPC sends tick array update (source: 'grpc')
           → tryActivate(P) → all deps source === 'grpc'? YES
           → ACTIVATED ✅ (now reliable)
```

---

## 6. Recommended Architecture

### Option A: gRPC-Triggered Bootstrap + gRPC-Confirmed Activation (Recommended)

> **Terminology Note**: "Pure gRPC discovery" is a misnomer. gRPC does not bootstrap
> anything—it triggers RPC bootstrap and confirms activation. The correct description is:
> **gRPC-triggered per-pool bootstrap with gRPC-confirmed activation**.

```
┌─────────────────────────────────────────────────────────────────┐
│                     STARTUP                                      │
├─────────────────────────────────────────────────────────────────┤
│  1. Start gRPC subscription (4 program IDs)                     │
│     └─→ Record grpc_subscription_start_slot                     │
│  2. gRPC streams existing pools gradually (~2-5 min)            │
│  3. Each pool discovery triggers per-pool RPC bootstrap         │
│  4. NO fullSnapshotBootstrap                                    │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PER-POOL FLOW                                  │
├─────────────────────────────────────────────────────────────────┤
│  gRPC discovers pool P                                          │
│    ├─→ lifecycle.discover(P, slot)                              │
│    ├─→ subscribeVaults(P) via gRPC                              │
│    └─→ fetchPoolDeps(P)                                         │
│          ├─→ Use bitmap: only 3-7 tick/bin arrays               │
│          ├─→ RPC fetch with minContextSlot (5-20ms)             │
│          ├─→ commitAccountUpdate (source: 'bootstrap')          │
│          ├─→ freezeTopology(P) → TOPOLOGY_FROZEN                │
│          └─→ tryActivate(P) → NOT YET (no gRPC confirmation)    │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CONVERGENCE                                    │
├─────────────────────────────────────────────────────────────────┤
│  gRPC sends updates for pool P's dependencies                   │
│    ├─→ commitAccountUpdate (source: 'grpc')                     │
│    ├─→ tryActivate(P) checks:                                   │
│    │     - All deps exist? YES                                  │
│    │     - All deps converged? YES                              │
│    │       (converged = grpc OR valid bootstrap)                │
│    └─→ ACTIVATED ✅                                             │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   STEADY STATE                                   │
├─────────────────────────────────────────────────────────────────┤
│  Pool P is ACTIVE                                               │
│    ├─→ gRPC updates flow directly to cache (0ms latency)        │
│    ├─→ Simulation uses 100% local cache                         │
│    └─→ RPC blocked by lifecycle (gRPC only)                     │
└─────────────────────────────────────────────────────────────────┘
```

### Why gRPC-Triggered Bootstrap?

| Aspect | Bulk Bootstrap (Current) | gRPC-Triggered Bootstrap |
|--------|--------------------------|--------------------------|
| Memory behavior | 1.5GB+ spike (crash) | Bounded, gradual (~400MB max) |
| Convergence | Race conditions | Deterministic |
| Failure mode | Catastrophic (OOM) | Graceful (pool stays FROZEN) |
| Startup time | 30-60s | 2-5 min |
| Code complexity | High | Low |

**The important distinction is NOT startup time.** It's:
- **Bounded memory with deterministic convergence** vs
- **Eager completeness with catastrophic failure**

Startup time is a secondary concern. Reliability and determinism are primary.

### Tick/Bin Array Timing

**Concern**: "Adding RPC latency of fetching tick/bins only when simulation introduces 200ms delay"

**Answer**: Fetch at DISCOVERY time, not SIMULATION time.

```
Discovery (one-time):
  gRPC sees pool → fetchPoolDeps → RPC gets tick/bins (5-20ms)

Simulation (repeated):
  Opportunity detected → use CACHED tick/bins (0ms)
```

The 5-20ms latency happens once per pool at discovery, not at simulation.

---

## 7. Implementation Plan

### Phase 1: Disable Bulk Bootstrap

**File**: `src/bootstrap/fullSnapshot.ts`

**Action**: Either delete or strip tick/bin fetching. Keep only if needed for pools/vaults.

**Alternative**: Set `bootstrapInProgress = false` from the start, letting gRPC trigger per-pool bootstrap.

### Phase 2: Add Source Tracking to Cache Entries

**Files**: `src/cache/pool.ts`, `src/cache/vault.ts`, `src/cache/tick.ts`, `src/cache/bin.ts`, `src/cache/ammConfig.ts`

**Action**: Store `source: 'grpc' | 'bootstrap'` in cache entries, not just for tracing.

```typescript
// Current CacheEntry
interface CacheEntry<T> {
    state: T;
    slot: number;
    writeVersion: bigint;
    updatedAtNs: bigint;
}

// Updated CacheEntry
interface CacheEntry<T> {
    state: T;
    slot: number;
    writeVersion: bigint;
    updatedAtNs: bigint;
    source: 'grpc' | 'bootstrap';  // ADD THIS
}
```

### Phase 3: Add Convergence Check to Activation

**File**: `src/topology/TopologyOracleImpl.ts`

**Action**: In `tryActivate()`, add check for gRPC confirmation.

```typescript
tryActivate(poolPubkey: Uint8Array, slot: number): ActivationResult {
    // ... existing checks ...

    // NEW: Check gRPC convergence
    if (!this.allDepsConfirmedByGrpc(topology)) {
        return {
            activated: false,
            reason: 'waiting_for_grpc',
            message: 'Dependencies exist but not yet confirmed by gRPC'
        };
    }

    // Activate
    lifecycle.activate(poolPubkey, slot);
    return { activated: true, reason: 'success' };
}

private allDepsConfirmedByGrpc(topology: FrozenTopology): boolean {
    // Check vaults
    const baseEntry = this.registry.vault.getEntry(topology.vaults.base);
    const quoteEntry = this.registry.vault.getEntry(topology.vaults.quote);
    if (baseEntry?.source !== 'grpc' || quoteEntry?.source !== 'grpc') {
        return false;
    }

    // Check tick arrays (skip non-existent/virtual)
    for (const idx of topology.requiredTickArrays) {
        if (this.registry.tick.isNonExistent(topology.poolPubkey, idx)) continue;
        const entry = this.registry.tick.getEntry(topology.poolPubkey, idx);
        if (entry?.source !== 'grpc') return false;
    }

    // Check bin arrays (skip non-existent/virtual)
    for (const idx of topology.requiredBinArrays) {
        if (this.registry.bin.isNonExistent(topology.poolPubkey, idx)) continue;
        const entry = this.registry.bin.getEntry(topology.poolPubkey, idx);
        if (entry?.source !== 'grpc') return false;
    }

    // Check ammConfig
    if (topology.ammConfigPubkey) {
        const entry = this.registry.ammConfig.getEntry(topology.ammConfigPubkey);
        if (entry?.source !== 'grpc') return false;
    }

    return true;
}
```

### Phase 4: Add Topology-Aware LRU Bounds

**Files**: `src/cache/tick.ts`, `src/cache/bin.ts`

**Action**: Add bounded eviction that respects ACTIVE topology references.

> **CRITICAL INVARIANT**: LRU eviction may only apply to cache entries that are
> NOT referenced by any ACTIVE topology. Violating this invariant causes silent
> simulation degradation without lifecycle transition (Heisenbugs).

**You must NOT evict:**
- Tick/bin arrays required by ACTIVE pools
- Vaults referenced by ACTIVE pools
- AMM configs in use by ACTIVE pools

**If eviction of a required entry is unavoidable, you must:**
1. Deactivate the pool (ACTIVE → TOPOLOGY_FROZEN or DISCOVERED)
2. Reset the topology freeze
3. Re-bootstrap when opportunity arises

**Implementation:**

```typescript
// In TickCache
evictIfSafe(key: string, lifecycle: LifecycleRegistry): boolean {
    // Parse pool pubkey from composite key
    const poolHex = key.split(':')[0];
    const poolPubkey = hexToBytes(poolHex);

    // Check if pool is ACTIVE
    const state = lifecycle.getState(poolPubkey);
    if (state === PoolLifecycleState.ACTIVE) {
        // Cannot evict - this tick array is required for simulation
        return false;
    }

    // Safe to evict
    this.cache.delete(key);
    return true;
}

// Bounded insertion with topology-aware eviction
set(...): CacheUpdateResult {
    if (this.cache.size >= MAX_ENTRIES) {
        // Find an entry that's safe to evict
        let evicted = false;
        for (const key of this.cache.keys()) {
            if (this.evictIfSafe(key, lifecycle)) {
                evicted = true;
                break;
            }
        }

        if (!evicted) {
            // All entries are referenced by ACTIVE pools
            // Option 1: Reject new entry (prefer existing ACTIVE pools)
            // Option 2: Deactivate oldest ACTIVE pool and evict
            console.warn('[TickCache] At capacity, all entries ACTIVE-referenced');
            return { updated: false, wasStale: false, reason: 'capacity' };
        }
    }

    // ... existing set logic
}
```

**Alternative: Pool-scoped eviction**

Instead of entry-level LRU, evict entire pools:

```typescript
// When at capacity, deactivate least-recently-used pool
function evictColdestPool(lifecycle: LifecycleRegistry): Uint8Array | null {
    const activePools = lifecycle.getPoolsByState(PoolLifecycleState.ACTIVE);

    // Sort by last simulation timestamp (if tracked)
    // Or by activation timestamp
    const coldest = activePools.sort((a, b) =>
        lifecycle.get(a).lastUsedAtMs - lifecycle.get(b).lastUsedAtMs
    )[0];

    if (coldest) {
        // Deactivate pool
        lifecycle.deactivate(coldest);  // Would need to add this method

        // Evict all its dependencies
        evictPoolDependencies(coldest);

        return coldest;
    }
    return null;
}
```

### Phase 5: Optimize Tick/Bin Fetching

**File**: `src/topology/fetchPoolDeps.ts`

**Action**: Use bitmap to fetch minimal tick/bin arrays (already partially implemented).

Current: Fetches ALL initialized tick arrays from bitmap
Better: Fetch only ±3-7 arrays around current tick

```typescript
// Current (in fetchClmmDeps)
const allInitializedIndexes = getAllInitializedTickArrays(pool.tickArrayBitmap, ...);

// Better
const currentStart = getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
const neededIndexes = [];
for (let offset = -tickArrayRadius; offset <= tickArrayRadius; offset++) {
    const idx = currentStart + offset * ticksPerArray;
    if (isInitialized(pool.tickArrayBitmap, idx)) {
        neededIndexes.push(idx);
    }
}
```

---

## 8. File-by-File Impact

### Files to Modify

| File | Change | Complexity |
|------|--------|------------|
| `src/cache/pool.ts` | Add `source` to CacheEntry, add `getEntry()` method | Low |
| `src/cache/vault.ts` | Add `source` to CacheEntry, add `getEntry()` method | Low |
| `src/cache/tick.ts` | Add `source`, add `getEntry()`, add LRU bounds | Medium |
| `src/cache/bin.ts` | Add `source`, add `getEntry()`, add LRU bounds | Medium |
| `src/cache/ammConfig.ts` | Add `source` to CacheEntry, add `getEntry()` method | Low |
| `src/topology/TopologyOracleImpl.ts` | Add `allDepsConfirmedByGrpc()` check | Medium |
| `src/handler/phase3.ts` | Disable `bootstrapInProgress` flag (or remove bootstrap call) | Low |
| `src/bootstrap/fullSnapshot.ts` | Delete or strip tick/bin fetching | Low |

### Files Unchanged

| File | Reason |
|------|--------|
| `src/cache/commit.ts` | Already passes `source`, no changes needed |
| `src/cache/lifecycle.ts` | State machine is correct |
| `src/topology/fetchPoolDeps.ts` | Per-pool logic is correct (maybe optimize tick radius) |
| `src/decode/*` | Decoders are correct |
| `src/sim/*` | Simulation math is correct |

---

## 9. Memory Budget

### Before (Current - Crashing)

| Component | Size |
|-----------|------|
| All pools | ~5MB |
| All vaults | ~3MB |
| ALL tick arrays (bulk) | ~1.1GB |
| ALL bin arrays (bulk) | ~210MB |
| Lifecycle, indexes, overhead | ~100MB |
| **TOTAL** | **~1.5GB+** (exceeds heap) |

### After (Recommended)

| Component | Size |
|-----------|------|
| All pools | ~5MB |
| All vaults | ~3MB |
| Hot tick arrays (LRU bounded) | ~200MB max |
| Hot bin arrays (LRU bounded) | ~50MB max |
| Lifecycle, indexes, overhead | ~50MB |
| **TOTAL** | **~300-400MB** |

### V8 Heap Configuration

```bash
# Recommend setting explicit heap limit
node --max-old-space-size=2048 dist/index.js
```

With 2GB heap and ~400MB cache, plenty of headroom for GC and other operations.

---

## 10. Validation Criteria

### Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Memory usage | <500MB steady state | `process.memoryUsage().heapUsed` |
| Activation rate | >95% for all venues | `pnpm evidence 600` + validation queries |
| No crashes | 24h+ runtime | Monitor process |
| Convergence | All active pools have gRPC-confirmed deps | New validation query |

### New Validation Query

```sql
-- Check convergence: find pools with INVALID bootstrap deps
-- (bootstrap data taken before gRPC subscription started)
SELECT
    pool_pubkey,
    COUNT(CASE WHEN source = 'grpc' THEN 1 END) as grpc_deps,
    COUNT(CASE WHEN source = 'bootstrap' AND slot < :grpc_subscription_start_slot THEN 1 END) as invalid_bootstrap_deps
FROM cache_traces
WHERE session_id = '<id>'
GROUP BY pool_pubkey
HAVING invalid_bootstrap_deps > 0;
-- Should return 0 rows for active pools
-- Note: bootstrap deps with slot >= grpc_subscription_start_slot are VALID
```

### Test Procedure

1. **Start fresh**: Clear cache, restart with pure gRPC discovery
2. **Monitor memory**: Watch heap usage over 10 minutes
3. **Check activation**: Query activation rates per venue
4. **Verify convergence**: Ensure no active pools have invalid bootstrap deps (slot < grpc_subscription_start_slot)
5. **Run evidence capture**: `pnpm evidence 600`
6. **Analyze validation_summary**: Check trust_status = 'OK'

---

## Summary

### The Problem
`fullSnapshot.ts` loads ALL tick/bin arrays at startup → 1.5GB+ → crash

### The Solution
1. **Disable bulk bootstrap** - Use pure gRPC discovery
2. **Per-pool bootstrap** - Fetch deps when gRPC discovers each pool
3. **Add convergence check** - Don't activate until gRPC confirms state
4. **Add LRU bounds** - Prevent unbounded memory growth

### What Stays the Same
- gRPC as source of truth
- Lifecycle state machine (DISCOVERED → FROZEN → ACTIVE)
- Slot-based staleness rejection
- `minContextSlot` for RPC handoff
- Simulation math

### Estimated Effort
~100-150 lines of changes across 8 files. No architectural rewrite needed.

---

## 11. Cache Mutation Invariants

These invariants are **non-negotiable**. Violating any of them breaks the system's reliability guarantees.

### Invariant 1: Single Entry Point for Mutations

```
Only commitAccountUpdate() may mutate cache state.
```

- Direct `cache.set()` calls are **PROHIBITED**
- All handlers (phase2, phase3, bootstrap) must go through `commitAccountUpdate()`
- This ensures staleness checks, source tracking, and trace emission are never bypassed

### Invariant 2: All Mutations Carry Full Metadata

```
Every cache mutation must include: (slot, writeVersion, source)
```

- `slot`: The Solana slot of the account state
- `writeVersion`: Monotonically increasing version for same-slot ordering
- `source`: Either `'grpc'` or `'bootstrap'`

Missing any of these fields makes convergence checks impossible.

### Invariant 3: No Simulation Path May Write State

```
Simulation and prediction code paths are read-only.
```

- Simulation must never mutate cache
- Quote calculation must never mutate cache
- Only gRPC handlers and bootstrap may write

### Invariant 4: RPC Writes Forbidden After Subscription

```
Any RPC write after gRPC subscription start is forbidden (except DISCOVERED/REFRESHING states).
```

- Lifecycle state machine enforces this
- `TOPOLOGY_FROZEN` and `ACTIVE` pools block RPC writes
- Only `DISCOVERED` and `REFRESHING` states allow RPC bootstrap

### Invariant 5: Eviction Respects Topology

```
LRU eviction may only apply to entries NOT referenced by any ACTIVE topology.
```

- Evicting an ACTIVE pool's dependency without deactivation causes silent failures
- If eviction is required, the pool must first be deactivated
- This prevents Heisenbugs where simulation silently degrades

### Invariant 6: Convergence Before Activation

```
A pool may only transition to ACTIVE if all dependencies are converged.
```

Converged means either:
- `source === 'grpc'`, OR
- `source === 'bootstrap'` AND `bootstrap.slot >= grpc_subscription_start_slot`

**Critical constraint**: `grpc_subscription_start_slot` must be:
- **Immutable**: Set once at startup, never changed
- **Global**: A single process-wide constant, not pool-specific
- **Captured atomically**: Recorded before ANY RPC bootstrap begins

If this value is mutable or per-pool, the convergence guarantee is broken.

### Summary Table

| Invariant | Enforced By | Violation Consequence |
|-----------|-------------|----------------------|
| Single entry point | `commitAccountUpdate()` | Staleness bugs, missing traces |
| Full metadata | Type system, runtime checks | Convergence deadlock |
| Read-only simulation | Code review, separation | State corruption |
| RPC blocked after subscribe | `lifecycle.ts` | Stale data in production |
| Topology-aware eviction | Eviction logic | Silent simulation failure |
| Convergence before activation | `tryActivate()` | Trading on stale state |

### Invariant 7: No Cross-Slot Synthesis

```
A single cache entry must never mix data derived from different slots.
```

This guards against subtle bugs where:
- One dependency is updated to slot S+1
- Another dependency remains at slot S
- Simulation assumes atomicity across all inputs

**Why this matters**: AMM math assumes all inputs (pool, vaults, tick arrays) represent a consistent point-in-time snapshot. Mixing slots produces economically invalid quotes.

**Enforcement**:
- Each cache entry has exactly one `slot` value
- Staleness checks reject updates that would create inconsistency
- Snapshot assembly must validate slot alignment before simulation

---

These invariants transform the cache from "best effort" to "production-grade deterministic."
