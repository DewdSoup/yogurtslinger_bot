# Brain Cache Architecture Analysis

## Executive Summary

This document analyzes the cache infrastructure in `yogurtslinger_bot/src/brain/` and compares it against `yogurt/src/cache/`. The brain module contains **battle-tested production patterns** for multi-venue opportunity detection that yogurt's cache infrastructure is missing.

Key findings:
1. **FragmentationTracker** provides O(1) multi-venue detection via `GRADUATION` and `NEW_FRAGMENTATION` events
2. **MarketCache** maintains separate per-venue pool indexes with cross-venue fragmentation discovery
3. **BinArrayCache** uses pool-to-array secondary indexes for O(1) bin lookups
4. **OpportunityScanner** provides event-driven arbitrage detection on vault updates
5. **ArbBrain** orchestrates detection-to-execution pipeline with local simulation validation

---

## 1. Brain Cache Architecture

### 1.1 MarketCache (`/home/dudesoup/code/yogurtslinger_bot/src/brain/marketCache.ts`)

**Purpose:** Unified market state across all venues with creation tracking and fragmentation discovery.

**Structure:**
```typescript
class MarketCache {
    // Per-venue pool maps
    private readonly pumpCurves = new Map<string, PumpCurveEntry>();
    private readonly raydiumPools = new Map<string, RaydiumPoolEntry>();
    private readonly raydiumCLMMPools = new Map<string, RaydiumCLMMPoolEntry>();
    private readonly pumpSwapPools = new Map<string, PumpSwapPoolEntry>();
    private readonly meteoraPools = new Map<string, MeteoraPoolEntry>();

    // Embedded TokenAccountCache for vault balances
    private readonly tokenAccounts: TokenAccountCache;

    // Event subscription for downstream consumers
    private readonly subscribers: AccountUpdateCallback[] = [];

    // Slot tracking for time estimation
    private highestSlot: bigint = 0n;
}
```

**Key Features:**
- **Initial Sync Detection:** Distinguishes pools seen during initial burst from newly created pools
- **Creation Tracking:** `createdSlot` / `createdTs` fields track when pools were created
- **Event Emission:** `subscribeToUpdates()` pattern allows downstream consumers (ArbBrain) to react
- **Cross-venue Fragmentation:** `getFragmentedTokens()` discovers tokens on 2+ venues

**Entry Structure:**
```typescript
interface PumpSwapPoolEntry {
    pubkey: string;
    slot: bigint;
    firstSeenTs: number;
    lastUpdatedTs: number;
    createdSlot: bigint | null;       // NEW: null if detected during sync
    createdTs: number | null;          // NEW: null if detected during sync
    detectedDuringSync: boolean;       // NEW: initial sync flag
    state: PumpSwapPoolState;
}
```

### 1.2 FragmentationTracker (`/home/dudesoup/code/yogurtslinger_bot/src/brain/fragmentationTracker.ts`)

**Purpose:** Real-time tracking of token presence across multiple venues for instant arbitrage detection.

**Structure:**
```typescript
class FragmentationTracker {
    // Main state: tokenMint -> fragmentation state
    private readonly tokens = new Map<string, TokenFragmentationState>();

    // O(1) lookup for fragmented tokens (2+ venues)
    private readonly fragmentedTokens = new Set<string>();

    // Event subscribers
    private readonly subscribers: EventCallback[] = [];

    // Recent fragmentations (sliding 60s window)
    private readonly recentFragmentations: { tokenMint: string; ts: number }[] = [];
}
```

**Event Types:**
```typescript
type FragmentationEventType =
    | "GRADUATION"           // First PumpSwap appearance (migrated from bonding curve)
    | "NEW_FRAGMENTATION"    // Token goes from 1 venue to 2+ (ARB OPPORTUNITY!)
    | "VENUE_ADDED";         // Already fragmented, another venue added
```

**O(1) Lookup Pattern:**
```typescript
// Hot path check - called on every vault update
isFragmented(tokenMint: string): boolean {
    return this.fragmentedTokens.has(tokenMint);  // O(1) Set lookup
}
```

**Critical Insight:** The `NEW_FRAGMENTATION` event is the primary signal for detecting new arbitrage opportunities. When a token transitions from 1 venue to 2+, there's likely a price discrepancy.

### 1.3 TokenAccountCache (`/home/dudesoup/code/yogurtslinger_bot/src/brain/tokenAccountCache.ts`)

**Purpose:** High-performance token account (vault) balance cache with zero latency operations.

**Structure:**
```typescript
class TokenAccountCache {
    private accounts = new Map<string, TokenAccountEntry>();
}

interface TokenAccountEntry {
    balance: bigint;
    lastUpdatedSlot: bigint;
    lastUpdatedTs: number;
    firstSeenTs: number;
}
```

**Key Operations:**
- `upsert(pubkey, balance, slot)` - O(1) update
- `getBalance(pubkey)` - O(1) lookup
- `getBalances(pubkeys[])` - Batch lookup
- `pruneStale(maxAgeMs)` - Memory management

### 1.4 BinArrayCache (`/home/dudesoup/code/yogurtslinger_bot/src/brain/binArrayCache.ts`)

**Purpose:** Decoded bin array storage for Meteora DLMM empty bin detection and liquidity analysis.

**Structure:**
```typescript
class BinArrayCache {
    private readonly arrays = new Map<string, CachedBinArray>();

    // CRITICAL: Secondary index for pool lookups
    private readonly poolToArrays = new Map<string, Set<string>>();
}

interface CachedBinArray {
    pda: string;
    poolPubkey: string;
    arrayIndex: bigint;
    bins: Map<number, CachedBin>;  // binId -> liquidity
    lastUpdated: number;
    binCount: number;
    filledCount: number;           // Bins with liquidity
}
```

**Key Features:**
- **Pool-to-Array Index:** Enables `getBinArraysForPool(poolPubkey)` without full scan
- **Per-Bin Lookup:** `getBin(poolPubkey, binId)` returns individual bin liquidity
- **Empty Bin Detection:** `isBinEmpty(poolPubkey, binId)` for JIT liquidity strategies
- **Liquidity Depth:** `getLiquidityDepth(poolPubkey, activeId, radius)` for slippage estimation

### 1.5 OpportunityScanner (`/home/dudesoup/code/yogurtslinger_bot/src/brain/opportunityScanner.ts`)

**Purpose:** Event-driven arbitrage detection triggered on vault balance updates.

**Structure:**
```typescript
class OpportunityScanner extends EventEmitter {
    // Token mint -> venue -> latest price
    private pricesByToken: Map<string, Map<string, PricePoint>> = new Map();

    // Pool pubkey -> token mint (reverse lookup)
    private poolToToken: Map<string, string> = new Map();

    // Graduated tokens (from PumpSwap)
    private graduatedMints: Set<string> = new Set();
}
```

**Hot Path Flow:**
```typescript
updatePrice(poolPubkey, priceInQuote, slot): ArbitrageOpportunity | null {
    // 1. Reverse lookup: pool -> token
    const tokenMint = this.poolToToken.get(poolPubkey);

    // 2. Only scan graduated tokens (high-volume)
    if (!this.graduatedMints.has(tokenMint)) return null;

    // 3. Update price point
    // 4. Scan all venues for this token
    return this.scanForOpportunity(tokenMint);
}
```

**Opportunity Detection:**
- Finds best buy (lowest price) and best sell (highest price)
- Computes spread accounting for per-venue fees
- Emits `opportunity` event when net profit exceeds threshold

### 1.6 ArbBrain (`/home/dudesoup/code/yogurtslinger_bot/src/brain/arbBrain.ts`)

**Purpose:** Orchestrator that wires MarketCache updates to local simulation and execution.

**Key Pattern:**
```typescript
async start(): Promise<void> {
    // Subscribe to cache updates
    this.cache.subscribeToUpdates(this.processUpdate.bind(this));
}

async processUpdate(pubkey: string, slot: number): Promise<void> {
    // Detect arbitrage signals
    const signals = await this.detector.detectArbs();

    for (const signal of signals) {
        // Build pool states from cache
        const buyPool = this.buildPoolState(signal.buyVenue, signal.tokenMint);
        const sellPool = this.buildPoolState(signal.sellVenue, signal.tokenMint);

        // Local simulation validation
        const localResult = await validateSignal(signal, this.cache, this.binArrayCache, ...);

        // Execute if approved
        if (localResult.approved) { ... }
    }
}
```

---

## 2. Yogurt Cache Architecture (Current State)

### 2.1 PoolCache (`/home/dudesoup/code/yogurtslinger_bot/red/yogurt/src/cache/pool.ts`)

**Structure:**
```typescript
class PoolCache implements IPoolCache {
    private cache: Map<string, CacheEntry<PoolState>> = new Map();
}
```

**Strengths:**
- Staleness detection via slot/writeVersion
- Source tracking (grpc/bootstrap)
- Evidence capture via traceHandler

**Missing:**
- No per-venue indexing
- No cross-venue fragmentation discovery
- No event emission pattern

### 2.2 VaultCache (`/home/dudesoup/code/yogurtslinger_bot/red/yogurt/src/cache/vault.ts`)

**Strengths:**
- Same staleness/source tracking as PoolCache

**Missing:**
- No reverse lookup (vault -> pool)
- No event emission on updates

### 2.3 BinCache/TickCache

**Strengths:**
- Composite keying (pool + index)
- Secondary index for account pubkey lookups
- Virtual zero arrays for non-existent entries
- Topology-aware eviction

**Missing:**
- No pool-to-arrays index (unlike brain's BinArrayCache)
- No empty bin ratio calculation

### 2.4 LifecycleRegistry (`/home/dudesoup/code/yogurtslinger_bot/red/yogurt/src/cache/lifecycle.ts`)

**Strengths:**
- State machine enforcement (DISCOVERED -> TOPOLOGY_FROZEN -> ACTIVE)
- RPC containment after freeze
- Reverse mappings (vault -> pool, ammConfig -> pool)

**Missing:**
- No fragmentation tracking
- No graduation events
- No event emission to downstream consumers

---

## 3. What Yogurt is Missing

### 3.1 FragmentationTracker (Critical for Opportunity Detection)

**Gap:** Yogurt has no way to detect when a token becomes tradeable on multiple venues.

**Integration Point:** Should integrate with `LifecycleRegistry.activate()`:
```typescript
// When pool activates, record venue for fragmentation tracking
activate(poolPubkey: Uint8Array, slot: number): boolean {
    // ... existing logic ...

    // NEW: Extract token mint from pool state, record venue
    const poolState = poolCache.get(poolPubkey);
    if (poolState) {
        fragmentationTracker.recordVenue(
            poolState.state.tokenMint,
            poolState.state.venue,
            poolPubkey,
            slot
        );
    }
}
```

### 3.2 Event Emission Pattern

**Gap:** Caches update silently. No downstream notification when:
- Vault balance changes
- Pool becomes active
- New fragmentation detected

**Integration Point:** Add subscriber pattern to VaultCache:
```typescript
class VaultCache {
    private subscribers: VaultUpdateCallback[] = [];

    subscribe(callback: VaultUpdateCallback): void {
        this.subscribers.push(callback);
    }

    set(...): CacheUpdateResult {
        // ... existing logic ...
        if (result.updated) {
            this.notifySubscribers(pubkey, amount, slot);
        }
    }
}
```

### 3.3 Cross-Venue Pool Indexing

**Gap:** No way to query "all pools for token X" without full scan.

**Brain Pattern:**
```typescript
// MarketCache has per-venue maps
getPumpSwapSolTokenPools(): Array<{entry, tokenMint, solIsBase}>
getMeteoraSolTokenPools(): Array<{entry, tokenMint, solIsX}>
getFragmentedTokens(): Map<tokenMint, {pumpSwap?, raydium?, meteora?}>
```

**Integration Point:** Add token-to-pools index:
```typescript
class PoolCache {
    // Add secondary index
    private tokenToPoolsIndex: Map<string, Set<string>> = new Map();

    set(...) {
        // Update main cache
        // Update tokenToPoolsIndex
    }

    getPoolsForToken(tokenMint: string): CacheEntry<PoolState>[] {
        const poolKeys = this.tokenToPoolsIndex.get(tokenMint);
        // Return all pool entries for this token
    }
}
```

### 3.4 OpportunityScanner Integration

**Gap:** Yogurt has simulation math but no event-driven opportunity detection.

**Integration Point:** Wire vault updates to opportunity scanner:
```typescript
// In phase4.ts or similar
vaultCache.subscribe((pubkey, amount, slot) => {
    // Get pool for this vault
    const poolPubkey = lifecycleRegistry.getPoolForVault(pubkey);
    if (!poolPubkey) return;

    // Compute price from vault balances
    const price = computePrice(poolPubkey);

    // Check for arbitrage
    opportunityScanner.updatePrice(poolPubkey, price, slot);
});
```

### 3.5 Creation Time Tracking

**Gap:** Yogurt tracks `discoveredAtSlot` but not `createdSlot` (when pool was created on-chain).

**Brain Pattern:**
```typescript
interface PoolEntry {
    createdSlot: bigint | null;       // null if detected during initial sync
    createdTs: number | null;
    detectedDuringSync: boolean;      // Flag for filtering
}
```

**Use Case:** New pool opportunities are highest value - they often have price inefficiencies.

---

## 4. Code Ready to Port

### 4.1 FragmentationTracker (Port Directly)

The FragmentationTracker is self-contained and can be ported with minimal changes:

```typescript
// src/cache/fragmentationTracker.ts

export type VenueType = "pumpSwap" | "raydiumV4" | "raydiumClmm" | "meteoraDlmm";

export interface FragmentationEvent {
    type: "GRADUATION" | "NEW_FRAGMENTATION" | "VENUE_ADDED";
    tokenMint: string;
    venue: VenueType;
    poolPubkey: string;  // Change to Uint8Array if preferred
    slot: number;        // Change to bigint if preferred
    allVenues: VenueType[];
    venueCount: number;
    timestamp: number;
}

export interface TokenFragmentationState {
    tokenMint: string;
    venues: Map<VenueType, TokenVenueInfo>;
    firstSeenTs: number;
    becameFragmentedTs: number | null;
    becameFragmentedSlot: number | null;
}

type EventCallback = (event: FragmentationEvent) => void;

export class FragmentationTracker {
    private readonly tokens = new Map<string, TokenFragmentationState>();
    private readonly fragmentedTokens = new Set<string>();
    private readonly subscribers: EventCallback[] = [];

    recordVenue(tokenMint: string, venue: VenueType, poolPubkey: string, slot: number): void {
        // ... implementation from brain ...
    }

    isFragmented(tokenMint: string): boolean {
        return this.fragmentedTokens.has(tokenMint);
    }

    subscribe(callback: EventCallback): void {
        this.subscribers.push(callback);
    }

    // ... rest of implementation ...
}

export const fragmentationTracker = new FragmentationTracker();
```

### 4.2 Event Subscription for VaultCache

Add subscriber pattern:

```typescript
// In src/cache/vault.ts

type VaultUpdateCallback = (pubkey: Uint8Array, amount: bigint, slot: number) => void;

export class VaultCache implements IVaultCache {
    // ... existing fields ...
    private subscribers: VaultUpdateCallback[] = [];

    subscribe(callback: VaultUpdateCallback): void {
        this.subscribers.push(callback);
    }

    private notifySubscribers(pubkey: Uint8Array, amount: bigint, slot: number): void {
        for (const callback of this.subscribers) {
            try {
                callback(pubkey, amount, slot);
            } catch (err) {
                console.error('[VaultCache] Subscriber error:', err);
            }
        }
    }

    set(
        pubkey: Uint8Array,
        amount: bigint,
        slot: number,
        writeVersion: bigint,
        dataLength: number,
        source: 'grpc' | 'bootstrap'
    ): CacheUpdateResult {
        // ... existing staleness check ...

        // ... existing cache.set() ...

        // NEW: Notify subscribers
        this.notifySubscribers(pubkey, amount, slot);

        // ... existing trace emission ...

        return result;
    }
}
```

### 4.3 Token-to-Pools Index for PoolCache

Add secondary index:

```typescript
// In src/cache/pool.ts

export class PoolCache implements IPoolCache {
    private cache: Map<string, CacheEntry<PoolState>> = new Map();

    // NEW: Token -> Pool secondary index
    private tokenToPools: Map<string, Set<string>> = new Map();

    set(
        pubkey: Uint8Array,
        state: PoolState,
        slot: number,
        writeVersion: bigint,
        dataLength: number,
        source: 'grpc' | 'bootstrap'
    ): CacheUpdateResult {
        const key = toKey(pubkey);

        // ... existing staleness check ...

        // Update main cache
        this.cache.set(key, entry);

        // NEW: Update token index
        const tokenMint = toKey(state.baseMint);  // Or however token mint is stored
        if (!this.tokenToPools.has(tokenMint)) {
            this.tokenToPools.set(tokenMint, new Set());
        }
        this.tokenToPools.get(tokenMint)!.add(key);

        // ... rest of method ...
    }

    // NEW: Get all pools for a token
    getPoolsForToken(tokenMint: Uint8Array): CacheEntry<PoolState>[] {
        const mintKey = toKey(tokenMint);
        const poolKeys = this.tokenToPools.get(mintKey);
        if (!poolKeys) return [];

        const results: CacheEntry<PoolState>[] = [];
        for (const poolKey of poolKeys) {
            const entry = this.cache.get(poolKey);
            if (entry) results.push(entry);
        }
        return results;
    }
}
```

### 4.4 Integration with LifecycleRegistry

Wire fragmentation tracking to pool activation:

```typescript
// In src/cache/lifecycle.ts

import { fragmentationTracker } from './fragmentationTracker.js';
import type { PoolCache } from './pool.js';

export class LifecycleRegistry {
    // Inject pool cache reference for state lookup
    private poolCache?: PoolCache;

    setPoolCache(cache: PoolCache): void {
        this.poolCache = cache;
    }

    activate(poolPubkey: Uint8Array, slot: number): boolean {
        // ... existing activation logic ...

        if (activated && this.poolCache) {
            const poolEntry = this.poolCache.get(poolPubkey);
            if (poolEntry) {
                const state = poolEntry.state;
                const tokenMint = toKey(state.baseMint);  // Extract token mint
                const venue = this.mapVenueIdToType(state.venue);

                fragmentationTracker.recordVenue(
                    tokenMint,
                    venue,
                    toKey(poolPubkey),
                    slot
                );
            }
        }

        return activated;
    }

    private mapVenueIdToType(venueId: number): VenueType {
        switch (venueId) {
            case 0: return 'pumpSwap';
            case 1: return 'raydiumV4';
            case 2: return 'raydiumClmm';
            case 3: return 'meteoraDlmm';
            default: throw new Error(`Unknown venue ID: ${venueId}`);
        }
    }
}
```

---

## 5. Integration Roadmap

### Phase 1: Event Infrastructure
1. Add subscriber pattern to VaultCache
2. Add subscriber pattern to LifecycleRegistry (for activate events)

### Phase 2: FragmentationTracker
1. Port FragmentationTracker class to yogurt
2. Wire to LifecycleRegistry.activate()
3. Add evidence capture for fragmentation events

### Phase 3: Token Index
1. Add token-to-pools secondary index to PoolCache
2. Add getPoolsForToken() method

### Phase 4: Opportunity Detection
1. Create OpportunityScanner (simplified version for S5)
2. Wire to VaultCache subscriber
3. Emit opportunity signals for S6 execution

---

## 6. Memory Considerations

Brain caches use string keys (base58 pubkeys). Yogurt uses Uint8Array with hex conversion.

**Recommendation:** Keep yogurt's hex key approach for consistency with existing caches. The hex conversion is already optimized:

```typescript
function toKey(pubkey: Uint8Array): string {
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += pubkey[i].toString(16).padStart(2, '0');
    }
    return key;  // 64-char hex string
}
```

Additional index overhead per pool:
- Token index: ~100 bytes per pool (hex key + Set overhead)
- Fragmentation tracker: ~200 bytes per token (Map + Set overhead)

For 10,000 pools across 4 venues = ~3MB additional memory. Acceptable given the O(1) lookup benefits.

---

## 7. Conclusion

The brain module's event-driven architecture with FragmentationTracker is **essential** for yogurt's S5 (Opportunity Detection) sprint. The core patterns to port:

1. **FragmentationTracker** - Critical for detecting new arb opportunities
2. **Event subscription** - Enables reactive downstream processing
3. **Token-to-pools index** - Required for cross-venue price comparison

These patterns are battle-tested in production and integrate cleanly with yogurt's existing lifecycle.ts infrastructure.
