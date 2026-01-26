# CACHE_REMEDIATION_PLAN.md

## Multi-Agent Convergence Audit Result

**Date:** 2026-01-14
**Auditors:** 6 Independent SME Agents
**Authority:** CACHE_AUDIT_PHASE0.md, updated_cache.md, FULL_SNAPSHOT_VERIFICATION.md
**Status:** LOCKED - All future edits must reference this plan

---

## 1. Executive Determination

### Decision: INCREMENTAL REMEDIATION

**Justification:**

The core cache architecture is fundamentally sound. The problems are localized and the required changes are additive, not rewrites.

| Component | Status | Evidence |
|-----------|--------|----------|
| Cache mutation entry point | CORRECT | `commit.ts` - all mutations via `commitAccountUpdate()` |
| Lifecycle state machine | CORRECT | `lifecycle.ts` - DISCOVERED → FROZEN → ACTIVE enforced |
| RPC blocking after freeze | CORRECT | `lifecycle.ts:489-551` - `isRpcAllowed()` works |
| Per-pool bootstrap | CORRECT | `fetchPoolDeps.ts` - production-ready, bounded |
| Staleness rejection | CORRECT | All caches implement slot/writeVersion checks |

**Why NOT Rebuild:**
- Would duplicate ~2,000 lines of working code
- Would introduce regression risk in proven logic
- Would delay production by weeks for no architectural gain
- The OOM crash is caused by ONE file (753 lines) that can be deleted

### SME Convergence Summary

| Question | Agreement | Verdict |
|----------|-----------|---------|
| Incremental vs Rebuild? | **6/6** | Incremental |
| Delete fullSnapshot.ts? | **6/6** | BLOCKING |
| Add source field? | **6/6** | REQUIRED |
| Track grpc_subscription_start_slot? | **6/6** | REQUIRED |
| Implement convergence check? | **6/6** | REQUIRED |
| Add LRU bounds? | **5/6** | REQUIRED (Phase 3) |
| Must not touch core files? | **6/6** | ENFORCED |

### Disagreement Resolution

**Disagreement 1: LRU Classification (REQUIRED vs OPTIONAL)**

- Memory SME: REQUIRED for long-term stability
- Risk SME: OPTIONAL but recommended

**Resolution:** LRU is REQUIRED for production but sequenced as Phase 3. With `fullSnapshot.ts` deleted, OOM is eliminated. LRU provides defense-in-depth against long-term memory growth from gRPC streaming. Evidence: 10,000+ pools × 10-50 tick arrays = potential 500K+ entries if unbounded.

**Disagreement 2: `from_slot` in gRPC Subscription**

- Solana/Geyser SME: Flagged as missing in `grpc.ts`
- Other SMEs: Did not explicitly address

**Resolution:** INCLUDE in Phase 1. Without `from_slot`, gRPC may start from current slot, creating a gap between RPC bootstrap and gRPC stream. Per Yellowstone best practices in `updated_cache.md` Section 2.2, this is required for convergence.

---

## 2. Phase Structure (LOCKED)

**Phase 1 — Crash & OOM Elimination (Blocking)**
**Phase 2 — Cache Provenance & Convergence (Correctness)**
**Phase 3 — Memory Safety & Eviction (Determinism)**
**Phase 4 — Optional Cleanup (Non-Blocking)**

No additional phases allowed.

---

## 3. Phase Details

### Phase 1 — Crash & OOM Elimination (Blocking)

**Objective:** Eliminate deterministic OOM crash; establish gRPC subscription baseline

**Files Affected:**

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `src/bootstrap/fullSnapshot.ts` | DELETE | -753 |
| `src/handler/phase3.ts` | MODIFY | ~-90 (remove bootstrap path) |
| `src/ingest/grpc.ts` | MODIFY | ~+5 (add from_slot parameter) |

**Specific Changes:**

1. **DELETE** `src/bootstrap/fullSnapshot.ts` (entire 753-line file)
   - Lines 468-489 enumerate ALL tick/bin arrays (1.5GB+)
   - FULL_SNAPSHOT_VERIFICATION.md confirms this is SOLE source of OOM

2. **MODIFY** `src/handler/phase3.ts`:
   - Remove import: `import { fullSnapshotBootstrap, type BootstrapResult } from '../bootstrap/fullSnapshot.js'` (line 36)
     > **Verified 2026-01-14:** Exact import text confirmed via `grep fullSnapshot src/handler/phase3.ts`
   - Remove `bootstrapInProgress` flag and all references
   - Remove `useFullBootstrap` config handling
   - Remove `runBootstrap()` method (lines 797-828, calls `fullSnapshotBootstrap()`)

3. **MODIFY** `src/ingest/grpc.ts`:
   - Add `fromSlot` parameter to subscription request (around line 390)
   - Capture and export `grpc_subscription_start_slot` at connection time

**Acceptance Criteria:**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` succeeds
- [ ] System starts without OOM crash
- [ ] gRPC subscription connects successfully
- [ ] `grpc_subscription_start_slot` is captured and immutable

**Rollback Criteria:**
- If gRPC connection fails after changes, revert `grpc.ts` changes first
- If typecheck fails, check for missing import updates

**Invariants Enforced:**
- Section 3: `fullSnapshot.ts` deleted (contains `fullSnapshotBootstrap()` function)
- Invariant 4: RPC blocked after subscribe (preserved)

**Invariants NOT Yet Enforced:**
- Invariant 6: Convergence before activation (Phase 2)
- Invariant 5: Topology-aware eviction (Phase 3)

---

### Phase 2 — Cache Provenance & Convergence (Correctness)

**Objective:** Enable convergence validation; gate activation on gRPC confirmation

**Files Affected:**

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `src/cache/types.ts` | MODIFY | ~+5 |
| `src/cache/pool.ts` | MODIFY | ~+15 |
| `src/cache/vault.ts` | MODIFY | ~+15 |
| `src/cache/tick.ts` | MODIFY | ~+15 |
| `src/cache/bin.ts` | MODIFY | ~+15 |
| `src/cache/ammConfig.ts` | MODIFY | ~+15 |
| `src/topology/TopologyOracleImpl.ts` | MODIFY | ~+60 |
| `src/handler/phase3.ts` | MODIFY | ~+10 |

**Specific Changes:**

1. **MODIFY** `src/cache/types.ts`:
   - Add `source: 'grpc' | 'bootstrap'` to `CacheEntry<T>` interface
   - Add `source` to `VaultBalance` interface
   - Add `source` to `AmmConfigEntry` interface

2. **MODIFY** all cache files to store source:
   - `pool.ts`: Store source in entry (line ~118)
   - `vault.ts`: Store source in VaultBalance (line ~108)
   - `tick.ts`: Store source in entry (line ~227)
   - `bin.ts`: Store source in entry (line ~223)
   - `ammConfig.ts`: Store source in entry (line ~87)

3. **ADD** `getEntry()` methods to all caches:
   - Return full `CacheEntry` with metadata, not just state
   - Required for convergence check to inspect `source` field

4. **MODIFY** `src/handler/phase3.ts`:
   - Access start slot via `grpcConsumer.getGrpcSubscriptionStartSlot()` (instance method)
   - Pass to TopologyOracleImpl constructor or provide as supplier function

5. **MODIFY** `src/topology/TopologyOracleImpl.ts`:
   - Add `isDependencyValid()` helper:
     ```typescript
     function isDependencyValid(entry, grpcSubscriptionStartSlot): boolean {
         if (!entry) return false;
         if (entry.source === 'grpc') return true;
         if (entry.source === 'bootstrap' && entry.slot >= grpcSubscriptionStartSlot) {
             return true;
         }
         return false;
     }
     ```
   - Add `allDepsConverged()` method
   - Modify `tryActivate()` (lines 114-184) to call `allDepsConverged()` before activation

**Acceptance Criteria:**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm evidence 60` completes without crash
- [ ] Pools show "waiting_for_grpc" status before convergence
- [ ] Pools activate only after deps are converged
- [ ] Static accounts (ammConfig) don't deadlock activation

**Rollback Criteria:**
- If activation deadlocks (0% activation after 5 minutes):
  - Check `grpcConsumer.getGrpcSubscriptionStartSlot()` returns non-null BEFORE any bootstrap
  - Check convergence condition includes bootstrap slot check
  - Temporary: Add bypass flag for debugging

**Invariants Enforced:**
- Invariant 2: All mutations carry full metadata (slot, writeVersion, source)
- Invariant 6: Convergence before activation
- Section 6.2: Source in CacheEntry
- Section 6.3: allDepsConfirmedByGrpc() equivalent

**Invariants NOT Yet Enforced:**
- Invariant 5: Topology-aware eviction (Phase 3)
- Section 6.4: LRU bounds on tick/bin (Phase 3)

---

### Phase 3 — Memory Safety & Eviction (Determinism)

**Objective:** Bound memory growth; implement topology-aware eviction

**Files Affected:**

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `src/cache/tick.ts` | MODIFY | ~+50 |
| `src/cache/bin.ts` | MODIFY | ~+50 |
| `src/cache/lifecycle.ts` | MODIFY | ~+30 |

**Specific Changes:**

> **Note on LRU bounds:** The values below are starting defaults based on estimated
> entry sizes (~11KB/tick, ~7KB/bin). Actual memory per entry depends on in-memory
> representation and V8 overhead. Treat these as initial bounds and tune based on
> evidence captures. The rollback criteria below include "increase MAX_SIZE limits"
> as the primary adjustment mechanism.

1. **MODIFY** `src/cache/tick.ts`:
   - Add `MAX_TICK_ENTRIES = 20000` (~220MB limit, starting default)
   - Add `evictIfSafe()` method checking lifecycle state
   - Modify `set()` to check capacity and evict if safe

2. **MODIFY** `src/cache/bin.ts`:
   - Add `MAX_BIN_ENTRIES = 7000` (~50MB limit, starting default)
   - Add `evictIfSafe()` method checking lifecycle state
   - Modify `set()` to check capacity and evict if safe

3. **MODIFY** `src/cache/lifecycle.ts`:
   - ADD `deactivate()` method: ACTIVE → DISCOVERED
   - Clear reverse mappings on deactivation
   - Allow re-discovery and re-bootstrap

**Acceptance Criteria:**
- [ ] Memory stays under 500MB after 10-minute capture
- [ ] No silent simulation failures (Heisenbugs)
- [ ] Eviction respects ACTIVE topology
- [ ] `deactivate()` properly clears state

**Rollback Criteria:**
- If simulation failures occur after eviction:
  - Increase MAX_SIZE limits
  - Check eviction is not touching ACTIVE pool deps
- If memory still grows unbounded:
  - Check eviction is actually triggering

**Invariants Enforced:**
- Invariant 5: Topology-aware eviction
- Section 6.4: LRU bounds on tick/bin

**Invariants NOT Yet Enforced:**
- All invariants now enforced after Phase 3

---

### Phase 4 — Optional Cleanup (Non-Blocking)

**Objective:** Remove dead code; improve codebase hygiene

**Files Affected:**

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `src/execute/submit.ts` | DELETE | -121 |
| `src/execute/bundle.ts` | DELETE | -148 |
| `src/execute/types.ts` | DELETE | -28 |
| `scripts/debug-tick-arrays.ts` | DELETE | ~-100 |
| `scripts/debug-tick-array-data.ts` | DELETE | ~-50 |
| `scripts/verify-reserves.ts` | DELETE | ~-100 |
| `scripts/verify-vault-deltas.ts` | DELETE | ~-50 |
| `scripts/verify-pda.ts` | DELETE | ~-50 |
| `scripts/profile-memory.ts` | DELETE | ~-100 |
| `scripts/debug-pda-derivation.ts` | DELETE | ~-50 |

**Acceptance Criteria:**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` succeeds
- [ ] No runtime errors from missing imports

**Rollback Criteria:**
- If any deletion breaks imports, restore and update callers first

**Invariants Enforced:**
- N/A (cleanup only)

---

## 4. File-Level Change Map

| File Path | Phase | Risk Level | Justification |
|-----------|-------|------------|---------------|
| `src/bootstrap/fullSnapshot.ts` | 1 | **HIGH** | DELETE - sole source of OOM crash |
| `src/handler/phase3.ts` | 1, 2 | MEDIUM | Remove bootstrap path, add slot tracking |
| `src/ingest/grpc.ts` | 1 | MEDIUM | Add from_slot, capture start slot |
| `src/cache/types.ts` | 2 | LOW | Add source field to interfaces |
| `src/cache/pool.ts` | 2 | LOW | Store source, add getEntry() |
| `src/cache/vault.ts` | 2 | LOW | Store source, add getEntry() |
| `src/cache/tick.ts` | 2, 3 | MEDIUM | Store source, getEntry(), LRU eviction |
| `src/cache/bin.ts` | 2, 3 | MEDIUM | Store source, getEntry(), LRU eviction |
| `src/cache/ammConfig.ts` | 2 | LOW | Store source, add getEntry() |
| `src/topology/TopologyOracleImpl.ts` | 2 | **HIGH** | Convergence check in tryActivate() |
| `src/cache/lifecycle.ts` | 3 | MEDIUM | Add deactivate() method |
| `src/execute/submit.ts` | 4 | LOW | DELETE - unimplemented stub |
| `src/execute/bundle.ts` | 4 | LOW | DELETE - unimplemented stub |
| `src/execute/types.ts` | 4 | LOW | DELETE - supports deleted modules |
| `scripts/debug-*.ts` | 4 | LOW | DELETE - test obsolete bootstrap |

---

## 5. Execution Rules

### Mandatory Constraints

1. **One phase at a time** - Do not begin Phase N+1 until Phase N acceptance criteria are met

2. **Evidence capture after each phase** - Run `pnpm evidence 60` minimum after each phase completes

3. **No phase proceeds if prior phase fails** - If acceptance criteria not met, fix current phase before proceeding

4. **All future edits must reference this plan** - Any deviation requires re-audit

5. **Commit after each phase** - Create git checkpoint with phase number in commit message

### Validation Procedure

After each phase:

```bash
# 1. Type check
pnpm typecheck

# 2. Build
pnpm build

# 3. Evidence capture (60s minimum for quick check, 600s for full validation)
pnpm evidence 60

# 4. Query validation
sqlite3 data/evidence/capture.db "SELECT metric_value FROM validation_summary WHERE metric_name = 'trust_status' ORDER BY created_at DESC LIMIT 1;"
```

### Phase Completion Checklist

- [ ] All acceptance criteria met
- [ ] Evidence capture completed
- [ ] No regressions in existing functionality
- [ ] Git commit created with phase reference
- [ ] Next phase ready to begin

---

## 6. Stop Conditions

### Pause Remediation If:

| Condition | Detection | Action |
|-----------|-----------|--------|
| OOM crash returns | Process crash during evidence capture | Check if fullSnapshot.ts fully deleted; check for other bulk loaders |
| Activation deadlock | 0% activation rate after 5 minutes | Check grpc_subscription_start_slot timing; check convergence condition |
| Memory growth > 1GB | `process.memoryUsage().heapUsed` | Check LRU eviction is triggering; check MAX_SIZE values |
| Simulation Heisenbugs | Intermittent wrong quotes | Check eviction not removing ACTIVE deps; add debug logging |
| gRPC connection failure | Stream disconnects repeatedly | Revert grpc.ts changes; check from_slot value |

### Re-Audit Required If:

- Any file in "MUST NOT TOUCH" list is modified
- New cache type is added
- Lifecycle state machine is altered
- Staleness check logic is changed

### Consider Clean Rebuild If:

- More than 3 phases fail acceptance criteria
- Fundamental invariant violation discovered in "CORRECT" components
- Memory issues persist after Phase 3 with max bounds

---

## 7. Definition of DONE

### All of the following must be true:

**Stability:**
- [ ] System runs 24+ hours without OOM crash
- [ ] Memory usage stays under 500MB steady state
- [ ] No process restarts required

**Correctness:**
- [ ] All active pools have converged dependencies
- [ ] No pools activate with RPC-only data (unless slot >= grpc_subscription_start_slot)
- [ ] `trust_status = 'OK'` in validation_summary

**Completeness:**
- [ ] Activation rate > 95% for all 4 venues (PumpSwap, RaydiumV4, RaydiumClmm, MeteoraDlmm)
- [ ] No invalid bootstrap deps (slot < grpc_subscription_start_slot) for active pools

**Code Quality:**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` succeeds
- [ ] All 7 invariants from updated_cache.md Section 11 enforced

### Final Validation Query

```sql
-- Run after 600s evidence capture
SELECT
    metric_name,
    metric_value,
    details
FROM validation_summary
WHERE metric_name IN ('trust_status', 'activation_rate', 'convergence_rate')
ORDER BY metric_name;

-- Expected results:
-- trust_status: OK
-- activation_rate: >95%
-- convergence_rate: 100%
```

---

## Appendix A: Files That MUST NOT Be Modified

| File | Reason |
|------|--------|
| `src/cache/commit.ts` | Single mutation entry point - VERIFIED CORRECT |
| `src/cache/lifecycle.ts` (existing methods) | State machine - VERIFIED CORRECT (only ADD deactivate()) |
| `src/topology/fetchPoolDeps.ts` | Per-pool bootstrap - PRODUCTION READY |
| `src/decode/*.ts` | Account decoders - VERIFIED CORRECT |
| `src/sim/math/*.ts` | AMM simulation math - VERIFIED CORRECT |
| `scripts/capture-evidence.ts` | Evidence capture - WORKING |

---

## Appendix B: Invariants Reference

From `updated_cache.md` Section 11:

| # | Invariant | Enforced By | Phase |
|---|-----------|-------------|-------|
| 1 | Single entry point for mutations | commit.ts | EXISTING |
| 2 | All mutations carry full metadata | types.ts, all caches | Phase 2 |
| 3 | Read-only simulation paths | Code structure | EXISTING |
| 4 | RPC blocked after subscribe | lifecycle.ts | EXISTING |
| 5 | Topology-aware eviction | tick.ts, bin.ts | Phase 3 |
| 6 | Convergence before activation | TopologyOracleImpl.ts | Phase 2 |
| 7 | No cross-slot synthesis | Staleness checks | EXISTING |

---

## Appendix C: Estimated Effort

| Phase | Lines Added | Lines Removed | Estimated Time |
|-------|-------------|---------------|----------------|
| Phase 1 | ~15 | ~850 | 1-2 hours |
| Phase 2 | ~150 | 0 | 3-4 hours |
| Phase 3 | ~130 | 0 | 3-4 hours |
| Phase 4 | 0 | ~750 | 30 minutes |
| **Total** | ~295 | ~1,600 | 8-12 hours |

---

## Appendix D: Token-2022 and Termination Semantics

### Classification

Token-2022 transfer fees and withheld ATAs do NOT break cache equivalence.
The local cache still correctly mirrors on-chain account state.

However, fee-bearing mints can violate implicit conservation assumptions
used by refresh or reconciliation logic, potentially preventing termination
(e.g. retry loops that never converge).

### Semantic Framing

Therefore, Token-2022 scanning and classification is treated as:

- **A termination / liveness guard** — Prevents infinite retry loops when
  token amounts don't reconcile due to transfer fee mechanics
- **NOT a correctness or activation requirement** — Pools with Token-2022
  mints can still activate; their cache state is still valid

This classification exists to bound convergence assumptions,
not to block activation or assert authority.

### Implications

1. Token-2022 detection does NOT gate pool activation
2. Token-2022 detection MAY be used to short-circuit retry logic
3. Token-2022 detection SHOULD be logged for observability
4. Token-2022 detection MUST NOT change cache mutation semantics

---

**END OF REMEDIATION PLAN**
