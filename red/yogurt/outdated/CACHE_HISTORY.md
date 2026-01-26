# Cache Subsystem History

**Created:** 2026-01-19
**Scope:** Complete remediation from OOM crisis to production certification
**Timeline:** Jan 14-18, 2026 (Phases 1-4.7)
**Status:** CERTIFIED & ACCEPTED

---

## Executive Summary

The local cache subsystem underwent a complete remediation to become a provably correct source of truth for mainnet Solana state. Starting from a critical OOM bug, the system was hardened through 4 major phases:

| Phase | Focus | Key Outcome |
|-------|-------|-------------|
| Phase 1 | OOM elimination | Deleted 753-line `fullSnapshot.ts`, RSS dropped from 5GB+ to ~285MB |
| Phase 2 | Convergence gating | 99.8% activation rate, source provenance tracking |
| Phase 3 | Memory bounds | Topology-aware eviction, MAX_TICK=18K, MAX_BIN=6K |
| Phase 4 | Evidence completeness | 99.93% activation, all audit checks PASS |

**Final certification:** Cache is production-ready for live trading decisions.

---

## Phase 1: OOM Elimination (Jan 14)

### Problem
`fullSnapshot.ts` (753 lines) loaded ALL tick/bin arrays at startup:
- ~100,000 tick arrays × 11KB = ~1.1GB
- ~30,000 bin arrays × 7KB = ~210MB
- Total: 1.5GB+ immediate spike → OOM crash

### Solution
1. **DELETED** `src/bootstrap/fullSnapshot.ts` entirely
2. Removed all bootstrap code paths from `phase3.ts`
3. Added `grpcSubscriptionStartSlot` capture for convergence validation
4. System now uses per-pool discovery via `fetchPoolDeps.ts` (already production-ready)

### Evidence
```
[capture 60s] P1=49462 ... rss=285MB  (was 5GB+ crash)
```

---

## Phase 2: Convergence Gating (Jan 15)

### Problem
Pools could activate with RPC-only bootstrap data before gRPC confirmed state—trading on potentially stale data.

### Solution
1. Added `source: 'grpc' | 'bootstrap'` to all cache entries
2. Implemented `isDependencyValid()` convergence check:
   - gRPC source → always valid
   - Bootstrap source → valid if slot ≥ grpcSubscriptionStartSlot
3. Gated activation on `allDepsConverged()`
4. Added static account bypass for `ammConfig` (protocol constants)

### Evidence
```sql
-- Activation rate: 99.8%
SELECT event_type, COUNT(*) FROM topology_events GROUP BY event_type;
-- freeze: 3061, activate: 3056

-- All incomplete pools due to virtual arrays (expected), not convergence
SELECT reason, COUNT(*) FROM topology_events WHERE event_type='incomplete' GROUP BY reason;
-- "No real tick/bin arrays - all 7 are virtual": 150
```

---

## Phase 3: Memory Bounds & Eviction (Jan 15-16)

### Problem
Tick/bin caches were unbounded `Map<>` structures with no eviction—memory growth unbounded.

### Solution
1. Added bounds: `MAX_TICK_ENTRIES=18000`, `MAX_BIN_ENTRIES=6000`
2. Implemented topology-aware `evictIfSafe()`:
   - Cannot evict entries for ACTIVE or REFRESHING pools
   - Uses "oldest evictable" strategy (not global LRU)
   - Added `lifecycle.deactivate()` API
3. Added `evicted` column to `cache_traces` for observability

### Hotfix: BigInt Bitmap Hang
During Phase 3 validation, evidence capture was hanging at ~55s. Root cause: V8 BigInt infinite loop when Meteora DLMM bitmap words contained `0xFFFFFFFFFFFFFFFF` (becomes `-1n` as signed).

**Fix:** Added `asU64()` masking helper to all bitmap operations:
```typescript
const U64_MASK = 0xFFFFFFFFFFFFFFFFn;
const asU64 = (x: bigint): bigint => x & U64_MASK;
```

Also added CPU watchdog and enhanced SIGUSR2 handler for future debugging.

### Evidence
```
RSS observed: 181-284MB during captures (well under 500MB threshold)
Eviction infrastructure verified in place
```

---

## Phase 4: Evidence Completeness (Jan 16)

### 4.1 startSlot Persistence
- Persisted `grpc_subscription_start_slot` to evidence database
- Added idempotent migration for existing databases

### 4.3 Evidence Audit (8/8 PASS)
| Check | Result |
|-------|--------|
| Session exists | PASS |
| Activation rate ≥95% | PASS (99.93%) |
| Incomplete pools have reasons | PASS |
| Eviction observability | PASS |
| Cache plane coverage (6/6) | PASS |
| startSlot forensics | PASS |
| Staleness rejection | PASS (1,915 rejected) |
| Evidence completeness | PASS |

### 4.5-4.7 Final Polish
- DEBUG-only logging for RPC rejections and eviction blocks
- Hardened semantic contracts for static account bypass
- Documentation + DEBUG assertions for bypass logic

---

## Final Verification Results

### CACHE_TRUST_RESULTS (15 tests)
| Category | Tests | Result |
|----------|-------|--------|
| A: Stream Integrity | 2 | PASS |
| B: Cache Completeness | 3 | PASS |
| C: Staleness & Ordering | 2 | PASS |
| D: RPC Containment | 1 | PASS |
| E: Data Integrity | 2 | PASS |
| F: Slot Consistency | 2 | DIAGNOSTIC |
| G: Health Stability | 2 | PASS |

**12 PASS, 0 FAIL, 3 DIAGNOSTIC**

### Key Metrics
- **Activation rate:** 99.93% (2953/2955 frozen→activated)
- **Staleness rejections:** 1,915 blocked (system working correctly)
- **Zero bootstrap-only pool activations**
- **Zero gRPC updates before subscription start**

---

## Certified Guarantees

### Cache Correctness
- All mutations flow through `commitAccountUpdate()` single entry point
- Every entry stores: `slot`, `writeVersion`, `source`
- Stale updates rejected deterministically

### Convergence Safety
- Pool account itself must be converged before activation
- All dependencies (vaults, tick arrays, bin arrays, configs) must converge
- Static-account bypass explicitly constrained to `ammConfig`

### Temporal Guarantees
- `grpc_subscription_start_slot` captured once, immutable, reset on reconnect
- No gRPC update with slot < start slot ever accepted

### Termination & Safety
- Convergence is bounded; infinite retry impossible
- CPU spin and event-loop stalls detected
- Eviction bounded and topology-aware

---

## Files Deleted (This Consolidation)

### Changelogs (16 files)
- PHASE1_CHANGELOG.md, PHASE1_5_RECONCILIATION.md, PHASE1_SCHEMAFIX_CHANGELOG.md
- PHASE2_CHANGELOG.md, PHASE2_1_POOL_CONVERGENCE_CHANGELOG.md
- PHASE3_0_CHANGELOG.md, PHASE3_1_CHANGELOG.md, PHASE3_1_COMPLETION_CHANGELOG.md
- PHASE3_1_FINAL_CHANGELOG.md, PHASE3_2_CHANGELOG.md
- PHASE4_1_CHANGELOG.md, PHASE4_5_DEBUG_VISIBILITY.md
- PHASE4_6_SEMANTIC_CONTRACTS.md, PHASE4_7_FINAL_POLISH.md
- HOTFIX_BIGINT_BITMAP_HANG.md, PHASE_EVICTION_FIX_CHANGELOG.md

### Preflight Reports (6 files)
- PHASE1_PREFLIGHT_REPORT.md, PHASE2_PREFLIGHT_REPORT.md
- PHASE3_PREFLIGHT_REPORT.md, PHASE4_1_PREFLIGHT_REPORT.md
- PHASE_EVICTION_AND_TRAVERSAL_PREFLIGHT.md, PHASE_EVICTION_PREFLIGHT_FINAL.md

### Audits (3 files)
- CACHE_AUDIT_PHASE0.md, FULL_SNAPSHOT_VERIFICATION.md, PHASE4_3_AUDIT.md

### Certifications (4 files)
- FORMAL_RELIABILIY_CERTIFICATION.md, CACHE_STATE_ACCEPTED.md
- CACHE_TRUST_RESULTS.md, CACHE_TRUST_ACCEPTANCE.md

### Historical (2 files)
- MEMORY_CHARACTERIZATION_PHASE2.md, old_repos.md

---

## Key Implementation Locations

| Component | File | Line |
|-----------|------|------|
| Cache mutation entry point | `src/cache/commit.ts` | `commitAccountUpdate()` |
| Lifecycle state machine | `src/cache/lifecycle.ts` | `PoolLifecycleState` enum |
| Convergence validation | `src/topology/TopologyOracleImpl.ts` | `isDependencyValid()` |
| Tick eviction | `src/cache/tick.ts` | `evictIfSafe()` |
| Bin eviction | `src/cache/bin.ts` | `evictIfSafe()` |
| BigInt bitmap fix | `src/decode/programs/meteoraDlmm.ts` | `asU64()` helper |
| Evidence capture | `scripts/capture-evidence.ts` | Main capture script |

---

## Change Control Policy (Going Forward)

The cache is now **infrastructure**, not an experimentation surface:

- No new features may be added
- No refactors without a correctness bug
- Performance changes must not alter semantics
- Any modification requires:
  - Clearly defined bug
  - Reproducible evidence
  - Minimal, targeted change

---

**END OF CACHE HISTORY**
