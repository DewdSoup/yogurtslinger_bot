# Speculative State Architecture Report

## S4.5 Sprint: Dual-Layer State Management Analysis

**Date:** 2026-01-21
**Scope:** Comparison of yogurt `src/pending/` vs red `src/state/` for speculative overlay implementation

---

## Executive Summary

This report analyzes the speculative state management architectures in two related codebases:

1. **yogurt** (`/red/yogurt/src/pending/`): Production MEV pipeline with existing pending queue and basic speculative layer
2. **red** (`/red/src/state/`): Research codebase with comprehensive dual-layer state management patterns

The key finding is that **yogurt's current SpeculativeStateLayer sums deltas** which is **incorrect for CPMM** when multiple pending swaps touch the same pool. The S4.5 sprint correctly identifies the need for **order-aware replay** which the red codebase's `SpeculativeStateManager` partially addresses.

---

## 1. Current yogurt Pending Infrastructure

### 1.1 Core Files

| File | Purpose |
|------|---------|
| `/red/yogurt/src/pending/queue.ts` | Pending TX queue with O(1) insert, ordered iteration |
| `/red/yogurt/src/pending/speculative.ts` | Current speculative layer (sum-deltas approach) |
| `/red/yogurt/src/cache/commit.ts` | Canonical cache commit with lifecycle enforcement |
| `/red/yogurt/src/cache/lifecycle.ts` | State machine: DISCOVERED -> FROZEN -> ACTIVE |

### 1.2 PendingTxQueue Architecture

```
src/pending/queue.ts
```

**Key Data Structures:**

```typescript
interface PendingTxEntry {
    signature: Uint8Array;
    slot: number;
    decoded: DecodedTx;
    rawUpdate: TxUpdate;
    receivedAtNs: bigint;
    deltas?: PoolDelta[];  // Pre-computed deltas
}

interface PoolDelta {
    pool: Uint8Array;
    vaultADelta: bigint;  // Positive = inflow
    vaultBDelta: bigint;
}
```

**Ordering Guarantees:**
- Sorted by `(slot ASC, signature ASC)` for deterministic replay
- O(1) insert via Map + lazy ordered array rebuild
- Configurable expiration: slots behind head OR time-based

**Key Methods:**

```typescript
insert(entry: PendingTxEntry): boolean      // Add pending tx
confirm(signature: Uint8Array): boolean     // Remove on confirmation
getOrdered(): PendingTxEntry[]              // Get in replay order
getForPool(pool: Uint8Array): PendingTxEntry[]  // Filter by pool
```

### 1.3 Current SpeculativeStateLayer (Problematic)

```
src/pending/speculative.ts
```

**Current Approach (Sum-Deltas):**

```typescript
// PROBLEMATIC: This sums deltas which breaks CPMM math
applyPendingTx(entry: PendingTxEntry): void {
    for (const delta of entry.deltas) {
        poolDelta.vaultADelta += delta.vaultADelta;  // WRONG for CPMM!
        poolDelta.vaultBDelta += delta.vaultBDelta;
    }
}
```

**Why Sum-Deltas Fails:**

For CPMM (constant product), swap output depends on current reserves:
```
dy = y * dx / (x + dx)
```

If two pending swaps affect the same pool:
- Swap 1: reserves (1000, 1000) -> input 100 -> output ~91
- Swap 2: reserves (1100, 909) -> input 100 -> output ~76

Summing deltas would give `91 + 91 = 182` output instead of `91 + 76 = 167`.

**Error magnitude:** ~9% in this example, compounding with more pending txs.

### 1.4 Cache Lifecycle Enforcement

```
src/cache/lifecycle.ts
```

The lifecycle system ensures RPC cannot corrupt confirmed state after freeze:

```
(null) -> DISCOVERED -> TOPOLOGY_FROZEN -> ACTIVE
              |              |
         RPC allowed    RPC blocked (gRPC only)
              |
              v
         REFRESHING (epoch transition)
```

**Key Invariant:** Once TOPOLOGY_FROZEN, only gRPC can update cache state.

**Integration Point for S4.5:** Speculative overlay reads from confirmed cache but NEVER writes to it.

---

## 2. red/src/state/ Dual-Layer Architecture

### 2.1 Overview

The red codebase provides a more complete dual-layer architecture:

| File | Purpose |
|------|---------|
| `speculativeState.ts` | Dual-layer manager with pending queue |
| `hotPathCache.ts` | Zero-allocation buffer accessors for hot path |
| `unifiedPoolRegistry.ts` | Cross-venue pool index with price divergence |
| `accountStore.ts` | Versioned account storage with snapshot |
| `poolRegistry.ts` | Account-to-pool reverse index |

### 2.2 SpeculativeStateManager (Key Reference)

```
/red/src/state/speculativeState.ts
```

**Architecture Diagram:**

```
+-----------------------------------------------------------------------+
|                     SPECULATIVE STATE MANAGER                          |
+-----------------------------------------------------------------------+
|                                                                       |
|  Layer 1: CONFIRMED STATE (Source of Truth)                          |
|  +-------------------------------------------------------------------+|
|  | InMemoryAccountStore                                               ||
|  | * Fed by Yellowstone gRPC (confirmed commitment)                  ||
|  | * Used for validation, regression, accuracy verification          ||
|  | * NEVER modified by speculative data                              ||
|  +-------------------------------------------------------------------+|
|                          |                                            |
|                          | clone on demand                            |
|                          v                                            |
|  Layer 2: SPECULATIVE STATE (Prediction Layer)                       |
|  +-------------------------------------------------------------------+|
|  | PendingTransactionQueue                                            ||
|  | * Fed by ShredStream (pre-confirmation entries)                   ||
|  | * Transactions applied in order to predict post-state             ||
|  | * Invalidated when confirmed state advances                       ||
|  +-------------------------------------------------------------------+|
|                          |                                            |
|                          v                                            |
|  Layer 3: OPPORTUNITY DETECTION                                      |
|  +-------------------------------------------------------------------+|
|  | * Simulate pending swap -> get predicted post-state               ||
|  | * Run arb detection on predicted state                            ||
|  | * If profitable: build bundle, submit to Jito                     ||
|  +-------------------------------------------------------------------+|
|                                                                       |
+-----------------------------------------------------------------------+
```

**Key Types:**

```typescript
interface PendingTransaction {
    signature: string;
    seenSlot: number;
    seenAt: number;
    rawTx: Buffer;
    instructions: PendingInstruction[];
    readAccounts: PubkeyStr[];
    writeAccounts: PubkeyStr[];
    status: "pending" | "confirmed" | "failed" | "expired";
}

interface SpeculativeStateDelta {
    sourceTx: string;
    accountDeltas: Map<PubkeyStr, SpeculativeAccountDelta>;
    tokenDeltas: Map<PubkeyStr, bigint>;
    confidence: number;
    expirySlot: number;
}
```

**Transaction Lifecycle:**

```typescript
// 1. Add from ShredStream
manager.addPendingTransaction(tx);

// 2. Query pending affecting account
const pending = manager.getPendingAffecting(poolPubkey);

// 3. On confirmation (from gRPC)
manager.confirmTransaction(signature);

// 4. On failure
manager.failTransaction(signature);
```

**Slot-Based Invalidation:**

```typescript
setConfirmedSlot(slot: number): void {
    this.confirmedSlot = slot;
    // Invalidate stale speculative deltas
    for (const [sig, delta] of this.speculativeDeltas) {
        if (delta.expirySlot <= slot) {
            this.speculativeDeltas.delete(sig);
        }
    }
}
```

### 2.3 HotPathCache (Zero-Allocation Reads)

```
/red/src/state/hotPathCache.ts
```

**Critical Pattern:** Direct buffer reads avoid allocation in hot path.

```typescript
// Zero-allocation u64 read from SPL Token account
function readTokenAmount(data: Buffer): bigint | undefined {
    if (data.length < 72) return undefined;
    return data.readBigUInt64LE(64);  // Amount at offset 64
}

// CLMM-specific reads
function readClmmLiquidity(data: Buffer): bigint | undefined
function readClmmSqrtPriceX64(data: Buffer): bigint | undefined
function readClmmTickCurrent(data: Buffer): number | undefined

// DLMM-specific reads
function readDlmmActiveId(data: Buffer): number | undefined
function readDlmmBinStep(data: Buffer): number | undefined
```

**Dirty Tracking:**

```typescript
class HotPathCache {
    onAccountUpdate(accountKey: PubkeyStr): Set<PubkeyStr> {
        const affected = this.registry.getPoolsForAccount(accountKey);
        for (const poolId of affected) {
            const pool = this.pools.get(poolId);
            if (pool) pool.dirty = true;  // Mark for re-simulation
        }
        return affected;
    }
}
```

### 2.4 UnifiedPoolRegistry (Cross-Venue Arbitrage)

```
/red/src/state/unifiedPoolRegistry.ts
```

**Purpose:** Enable cross-venue arbitrage detection by tracking price divergence.

```typescript
interface PriceDivergence {
    baseMint: PubkeyStr;
    quoteMint: PubkeyStr;
    cheapPool: PoolInfo;
    expensivePool: PoolInfo;
    spreadBps: number;
    cheapPriceQ64: bigint;
    expensivePriceQ64: bigint;
}
```

**Key Methods:**

```typescript
registerPool(info: PoolInfo): void
updatePrice(poolAddress: PubkeyStr, priceQ64: bigint, slot: number): void
findDivergences(minSpreadBps: number = 10): PriceDivergence[]
getCrossVenuePairs(): { baseMint, quoteMint, venues: VenueType[] }[]
```

### 2.5 InMemoryAccountStore (Versioned State)

```
/red/src/state/accountStore.ts
```

**Key Features:**
- Slot + writeVersion ordering for staleness detection
- Interest-only tracking (store subset of accounts)
- Zero-allocation data access via `getData(pubkey)`
- Snapshot creation for simulation

```typescript
interface AccountStore {
    apply(update: AccountUpdate): boolean;
    get(pubkey: PubkeyStr): AccountView | undefined;
    snapshot(pubkeys: Iterable<PubkeyStr>): AccountSnapshot;
    track(pubkey: PubkeyStr): void;
}
```

**Ordering Logic:**

```typescript
function isNewer(slotA, writeA, slotB, writeB): boolean {
    return slotA > slotB || (slotA === slotB && writeA > writeB);
}
```

---

## 3. S4.5 Order-Aware Replay Pattern

### 3.1 Core Problem Statement

From `SPRINT_PLAN_FINAL.md`:

> Summing "deltas" is incorrect for CPMM when multiple pending swaps touch the same pool (output depends on prior reserve updates). The correct approach is **per-pool ordered replay**.

### 3.2 Correct Architecture (S45-T7)

**File:** `src/pending/speculativeReplay.ts` (to be created)

**Core API:**

```typescript
interface SpeculativeReplayOverlay {
    // Add pending tx, extract swap legs, create per-pool ops
    addPendingTx(entry: PendingTxEntry): void;

    // Remove on confirmation or expiration
    removePendingTx(signature: Uint8Array): void;

    // Get speculative reserves by replaying in order
    getSpeculativeReserves(
        pool: Uint8Array,
        confirmedBaseReserve: bigint,
        confirmedQuoteReserve: bigint
    ): { baseReserve: bigint; quoteReserve: bigint; pendingCount: number };

    // Check if pool has pending ops
    hasPendingOps(pool: Uint8Array): boolean;
}
```

**Internal Storage:**

```typescript
interface PendingSwapOp {
    signature: Uint8Array;
    pendingOrder: bigint;  // Global ordering key
    legIndex: number;      // For multi-leg txs
    venue: VenueId;
    swapMode: 'ExactIn' | 'ExactOut';
    inputAmount: bigint;
    // For exactOut:
    maxInput?: bigint;
}

// Per-pool ops list
type PoolOps = Map<string, PendingSwapOp[]>;  // poolKey -> sorted ops
```

### 3.3 Order-Aware Replay Algorithm

```typescript
function getSpeculativeReserves(
    pool: Uint8Array,
    confirmedA: bigint,
    confirmedB: bigint
): { baseReserve: bigint; quoteReserve: bigint; pendingCount: number } {
    const ops = this.poolOps.get(toKey(pool));
    if (!ops || ops.length === 0) {
        return { baseReserve: confirmedA, quoteReserve: confirmedB, pendingCount: 0 };
    }

    // Sort by (pendingOrder, legIndex) for determinism
    const sorted = [...ops].sort((a, b) => {
        if (a.pendingOrder !== b.pendingOrder) {
            return a.pendingOrder < b.pendingOrder ? -1 : 1;
        }
        return a.legIndex - b.legIndex;
    });

    // Replay each op against evolving reserves
    let reserveA = confirmedA;
    let reserveB = confirmedB;

    for (const op of sorted) {
        const result = applyCpmmSwap(reserveA, reserveB, op);
        reserveA = result.newReserveA;
        reserveB = result.newReserveB;
    }

    return { baseReserve: reserveA, quoteReserve: reserveB, pendingCount: sorted.length };
}
```

### 3.4 Pending Order Assignment (S45-T2)

**Problem:** ShredStream entries don't have a global order within a slot.

**Solution:** Assign monotonic order on receipt:

```typescript
class PendingOrderAssigner {
    private headSlot = 0;
    private perSlotCounter: Map<number, bigint> = new Map();

    assign(slot: number): bigint {
        if (slot > this.headSlot) {
            this.headSlot = slot;
            this.cleanup();  // Drop counters for old slots
        }

        const counter = this.perSlotCounter.get(slot) ?? 0n;
        const order = (BigInt(slot) << 32n) | counter;
        this.perSlotCounter.set(slot, counter + 1n);

        return order;
    }
}
```

**Order Key Format:** `(slot << 32) | perSlotCounter`

---

## 4. Integration Recommendations

### 4.1 Required S4.5 Deliverables

Per `SPRINT_PLAN_FINAL.md`:

| Task | Description | Status |
|------|-------------|--------|
| S45-T1 | PendingTxEntry Extensions (pendingOrder, rawTx) | Pending |
| S45-T2 | Pending Order Assigner | Pending |
| S45-T3 | Evidence Capture Upgrade | Pending |
| S45-T4 | PendingTxQueue Update (stable ordering) | Pending |
| S45-T5 | SwapMode (ExactIn/ExactOut) Decoders | Pending |
| S45-T6 | CPMM Swap Application (cpmmApply.ts) | Pending |
| S45-T7 | Order-Aware Speculative Replay | Pending |
| S45-T8 | Phase 4 Wiring | Pending |
| S45-T9 | Evidence-Based Validation | Pending |
| S45-T10 | Overlay Observability | Pending |
| S45-T11 | Live Demo Script | Pending |

### 4.2 Code Snippets to Integrate

**From red `speculativeState.ts` - PendingTransactionQueue with write account indexing:**

```typescript
// Useful pattern: Index pending txs by write account for conflict detection
class PendingTransactionQueue {
    private byWriteAccount: Map<PubkeyStr, Set<string>> = new Map();

    add(tx: PendingTransaction): void {
        // Index by write accounts for conflict detection
        for (const acc of tx.writeAccounts) {
            let set = this.byWriteAccount.get(acc);
            if (!set) {
                set = new Set();
                this.byWriteAccount.set(acc, set);
            }
            set.add(tx.signature);
        }
    }

    getPendingWritersTo(account: PubkeyStr): PendingTransaction[] {
        const sigs = this.byWriteAccount.get(account);
        if (!sigs) return [];
        return [...sigs]
            .map(sig => this.pending.get(sig))
            .filter(tx => tx?.status === "pending")
            .sort((a, b) => a.seenAt - b.seenAt);
    }
}
```

**From red `hotPathCache.ts` - Zero-allocation reserve reads:**

```typescript
// Integrate into yogurt snapshot builder
function readTokenAmount(data: Buffer): bigint | undefined {
    if (data.length < 72) return undefined;
    return data.readBigUInt64LE(64);
}

// Hot path: Get reserves without allocating AccountView
getPumpSwapReserves(pool: CachedPumpSwapPool): { base: bigint; quote: bigint } | undefined {
    const baseData = this.store.getData(pool.baseVault);
    const quoteData = this.store.getData(pool.quoteVault);
    if (!baseData || !quoteData) return undefined;

    const base = readTokenAmount(baseData);
    const quote = readTokenAmount(quoteData);
    if (base === undefined || quote === undefined) return undefined;

    return { base, quote };
}
```

**CPMM Swap Application (S45-T6 reference):**

```typescript
// src/pending/cpmmApply.ts
interface SwapResult {
    newReserveIn: bigint;
    newReserveOut: bigint;
    amountOut: bigint;
}

function applyCpmmExactIn(
    reserveIn: bigint,
    reserveOut: bigint,
    amountIn: bigint,
    feeBps: number
): SwapResult {
    // Fee taken from input
    const feeMultiplier = 10000n - BigInt(feeBps);
    const amountInWithFee = (amountIn * feeMultiplier) / 10000n;

    // Constant product: dy = y * dx / (x + dx)
    const amountOut = (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee);

    return {
        newReserveIn: reserveIn + amountIn,
        newReserveOut: reserveOut - amountOut,
        amountOut,
    };
}

function applyCpmmExactOut(
    reserveIn: bigint,
    reserveOut: bigint,
    amountOut: bigint,
    feeBps: number
): SwapResult {
    // Calculate required input: dx = x * dy / (y - dy)
    const numerator = reserveIn * amountOut * 10000n;
    const denominator = (reserveOut - amountOut) * (10000n - BigInt(feeBps));
    const amountIn = (numerator / denominator) + 1n;  // Round up

    return {
        newReserveIn: reserveIn + amountIn,
        newReserveOut: reserveOut - amountOut,
        amountOut,
    };
}
```

### 4.3 Wiring Pattern for Phase 4

```typescript
// src/pending/index.ts - Wiring helper
import { PendingTxQueue, PendingTxEntry } from './queue.js';
import { SpeculativeReplayOverlay } from './speculativeReplay.js';
import { extractSwapLegs } from '../decode/legs.js';

export function wirePendingPipeline(
    queue: PendingTxQueue,
    overlay: SpeculativeReplayOverlay,
    poolLookup: (pubkey: Uint8Array) => PoolState | null
) {
    return {
        onPendingTx(
            signature: Uint8Array,
            slot: number,
            decoded: DecodedTx,
            rawUpdate: TxUpdate,
            pendingOrder: bigint
        ) {
            // 1. Extract swap legs
            const legs = extractSwapLegs(decoded, decoded.instructions, poolLookup);

            // 2. Build entry
            const entry: PendingTxEntry = {
                signature,
                slot,
                decoded,
                rawUpdate,
                receivedAtNs: process.hrtime.bigint(),
                pendingOrder,
                legs,
            };

            // 3. Enqueue
            queue.insert(entry);

            // 4. Add to overlay (extracts per-pool ops internally)
            overlay.addPendingTx(entry);
        },

        onConfirmedTx(signature: Uint8Array) {
            queue.confirm(signature);
            overlay.removePendingTx(signature);
        },
    };
}
```

---

## 5. Validation Strategy

### 5.1 Evidence-Based Validation (S45-T9)

```sql
-- Query from capture.db to validate speculative predictions
SELECT
    ps.signature,
    ps.pool_pubkey,
    ps.venue,
    ps.direction,
    ps.amount_in,
    -- Pre-swap reserves
    pre_vault_a.amount as pre_reserve_a,
    pre_vault_b.amount as pre_reserve_b,
    -- Post-swap reserves
    post_vault_a.amount as post_reserve_a,
    post_vault_b.amount as post_reserve_b
FROM parsed_swaps ps
JOIN cache_traces pre_vault_a ON pre_vault_a.pubkey = ps.vault_a AND pre_vault_a.slot < ps.slot
JOIN cache_traces pre_vault_b ON pre_vault_b.pubkey = ps.vault_b AND pre_vault_b.slot < ps.slot
JOIN cache_traces post_vault_a ON post_vault_a.pubkey = ps.vault_a AND post_vault_a.slot >= ps.slot
JOIN cache_traces post_vault_b ON post_vault_b.pubkey = ps.vault_b AND post_vault_b.slot >= ps.slot
WHERE ps.venue IN (0, 1)  -- CPMM venues only
ORDER BY ps.slot, ps.signature;
```

### 5.2 Accuracy Gate (G4.4)

From sprint plan:
> WBS Gate G4.4: Speculative state accuracy >= 99%

Validation script should:
1. Load confirmed swaps from `parsed_swaps`
2. Reconstruct pre-reserves from `cache_traces`
3. Apply swap via `applyCpmmSwapToReserves()`
4. Compare against post-reserves from `cache_traces`
5. Report: mean error, p95/p99 error, pass rate (<= 10 bps reserve error)
6. Exit non-zero if pass rate < 99%

---

## 6. Key Differences Summary

| Aspect | yogurt (current) | red (reference) | S4.5 Target |
|--------|------------------|-----------------|-------------|
| Delta application | Sum-based (broken) | Delta storage | Order-aware replay |
| Ordering | slot + signature | seenAt timestamp | pendingOrder (monotonic) |
| Write account index | No | Yes | Yes (conflict detection) |
| Hot path optimization | Basic | Zero-allocation | Integrate |
| Cross-venue tracking | No | UnifiedPoolRegistry | Future sprint |
| Validation | Basic | Per-sample recording | Evidence-based |

---

## 7. Conclusion

The S4.5 sprint correctly identifies the architectural gap: yogurt's current `SpeculativeStateLayer` uses sum-deltas which produces incorrect results for CPMM venues when multiple pending transactions affect the same pool.

**Key patterns to adopt from red/src/state:**

1. **Write account indexing** for conflict detection
2. **Zero-allocation buffer reads** for hot path
3. **Structured pending lifecycle** (pending -> confirmed/failed/expired)
4. **Slot-based invalidation** with configurable expiry

**Critical S4.5 deliverables:**

1. `pendingOrder` assignment for deterministic replay order
2. `cpmmApply.ts` with correct ExactIn/ExactOut math
3. `speculativeReplay.ts` with per-pool ordered replay
4. Evidence-based validation at 99% accuracy gate

The confirmed cache layer (`commit.ts` + `lifecycle.ts`) is already correctly isolated. The speculative overlay should be a **read-only view** that combines confirmed state with pending replay without mutation.
