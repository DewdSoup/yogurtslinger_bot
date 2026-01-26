# WIRING_NOTES.md

## Session Summary — 2026-01-19

### Objective

Wire valuable components from `old_tools/executor/` into the production pipeline to achieve:
- 100% local simulation (no RPC in hot path)
- Sub-millisecond decision latency
- Accuracy-based competitive edge
- Deterministic, auditable execution

---

## What We Did

### 1. Comprehensive Review of old_tools

Launched 6 parallel SME agents to analyze `old_tools/executor/`:

| Agent | Focus | Key Findings |
|-------|-------|--------------|
| 1 | Instruction Builders | 6 complete builders (Raydium CPMM/CLMM, Orca, Meteora DLMM, Lifinity, Phoenix) |
| 2 | Quoters & Math | CPMM, CLMM, DLMM quoters with tick/bin traversal |
| 3 | Execution/Submission | Complete RPC submission, NO Jito bundles |
| 4 | Route Discovery | Backtracking DFS, 2-8 hops, multi-venue |
| 5 | ML/Features | 40+ features per decision, JSONL logging |
| 6 | Entry Points | Live/SIM_ONLY/Shadow/Backtest modes |

**Key Gaps Identified:**
- No PumpSwap instruction builder
- No Jito bundle support (all standard RPC)
- Uses RPC/WS for data, not local cache

### 2. Created WIRING_OLD.md

Evidence-first Work Breakdown Structure with 7 phases:

| Phase | Focus | Gate |
|-------|-------|------|
| 0 | Inventory & Compilation | All files compile |
| 1 | CPMM Quoter | ≤0.01% error |
| 2 | CLMM/DLMM Quoters | ≤0.1% error, zero RPC |
| 3 | Instruction Builders | 100% sim pass rate |
| 4 | Route Discovery | 100% paths quotable |
| 5 | ML Features | 40+ features captured |
| 6 | Jito Bundles | NEW CODE |
| 7 | End-to-End | p99 < 1ms |

### 3. Identified Evidence Gap

For WIRING_OLD.md Phase 1-2 (quoter verification), we need:
- Confirmed swap transactions with `amount_in` and `amount_out`
- Current capture had raw txs but no parsed swap data

### 4. Added Plane 7 to capture-evidence.ts

**New Table:** `parsed_swaps`

```sql
CREATE TABLE parsed_swaps (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    confirm_ts INTEGER,
    slot INTEGER,
    signature TEXT,
    venue TEXT,                    -- pumpswap, raydiumV4, raydiumClmm, meteoraDlmm
    pool_pubkey TEXT,
    direction INTEGER,             -- 0=AtoB, 1=BtoA
    input_mint TEXT,
    output_mint TEXT,
    input_amount TEXT,             -- from instruction
    min_output_amount TEXT,        -- slippage limit from instruction
    actual_output_amount TEXT,     -- calculated from balance delta (GROUND TRUTH)
    tx_fee_lamports TEXT,
    decode_success INTEGER
);
```

**How It Works:**
1. Receives confirmed tx from gRPC (Plane 4)
2. Calls `extractSwapLegs()` from `src/decode/swap.ts`
3. Decodes swap instruction → gets `inputAmount`, `minOutputAmount`
4. Calculates `actualOutput` from pre/post token balance deltas
5. Stores with venue, pool, direction, mints, and tx fee

**Changes Made:**
- Added imports for swap decoders
- Added `parsed_swaps` table schema
- Added `stmtSwap` prepared statement
- Added swap parsing logic in `txStream.on('data')` handler
- Added `plane7_swaps` to stats tracking
- Updated progress log and final summary
- Updated header documentation

### 5. Ran 30-Minute Capture

User executed:
```bash
pnpm evidence 1800
```

This should have captured:
- Pool state updates (P1)
- Cache traces (P2)
- Pending shreds (P3)
- Confirmed transactions (P4)
- Topology events (P5)
- Frozen topologies (P6)
- **Parsed swaps (P7)** ← NEW

---

## What's Next

### Immediate: Verify Capture Data

```sql
-- Check swap counts by venue
SELECT venue, COUNT(*) as swaps
FROM parsed_swaps
GROUP BY venue;

-- Check if we have actual_output_amount populated
SELECT venue,
       COUNT(*) as total,
       COUNT(actual_output_amount) as with_output
FROM parsed_swaps
GROUP BY venue;

-- Sample swaps for verification
SELECT venue, pool_pubkey, input_amount, actual_output_amount, slot
FROM parsed_swaps
WHERE actual_output_amount IS NOT NULL
LIMIT 20;
```

### Then: Execute WIRING_OLD.md Phases

**Phase 0:** Verify old_tools components compile
**Phase 1:** Wire CPMM quoter, verify against parsed_swaps ground truth
**Phase 2:** Wire CLMM/DLMM quoters, verify tick/bin traversal accuracy
**Phase 3:** Wire instruction builders, verify RPC simulation pass rate

---

## Files Created/Modified

| File | Action |
|------|--------|
| `WIRING_OLD.md` | Created - Evidence-first integration WBS |
| `WIRING_NOTES.md` | Created - This summary |
| `scripts/capture-evidence.ts` | Modified - Added Plane 7 |

---

## Key Insight

The local cache (per `CACHE_STATE_ACCEPTED.md`) is trusted and frozen. The old_tools components are **UNTRUSTED** until verified against ground truth from Plane 7 parsed swaps.

Verification approach:
1. Take cached state at slot N
2. Run quoter with cached state
3. Compare quoter output to `actual_output_amount` from parsed_swaps
4. Calculate error percentage
5. Gate: p99 error must be ≤0.01% (CPMM) or ≤0.1% (CLMM/DLMM)

---

## Hardware Available (Not Yet Utilized)

| Resource | Spec | Utilization | Potential Use |
|----------|------|-------------|---------------|
| GPU | RTX 5070 12GB CUDA 13.0 | 0% | GPU route discovery |
| CPU | Threadripper 7960X 24-core | Low | Current pipeline |
| RAM | 503GB | Low | State caching |

GPU route discovery is planned for post-Phase 7 (after core wiring is complete).

---

## Evidence Files

| File | Purpose |
|------|---------|
| `data/evidence/capture.db` | SQLite database with all planes |
| `data/evidence/wiring_phase{N}.json` | Phase completion evidence (to be created) |

---

---

## Bug Fix Applied

**Issue:** `actual_output_amount` was not populating (0% coverage)

**Root Cause:** Mint format mismatch
- Token balances in gRPC use **base58** format (e.g., `So11111111111111111111111111111111111111112`)
- Swap decoder outputs **Uint8Array** which we converted to hex
- Comparison always failed

**Fix:** Convert `leg.outputMint` to base58 using `bs58.encode()` before comparison

```typescript
// Before (broken)
const outputMintHex = toHex(leg.outputMint);
if (postMint === outputMintHex) { ... }

// After (fixed)
const outputMintB58 = bs58.encode(leg.outputMint);
if (postBal.mint === outputMintB58) { ... }
```

**Next capture will have proper `actual_output_amount` populated.**

---

**Status:** Plane 7 fix applied. Run another capture to collect swaps with actual output amounts, then begin WIRING_OLD.md Phase 0.

---

## Comprehensive Review — 2026-01-19 (Session 2)

### Critical Bug Fixes Found

From `validate_fragmentation_strategy.mjs`:
- **PumpSwap fee**: Was 25bps in code, should be **30bps**
- **Meteora fee**: Was estimated by binStep, should use **baseFactor × binStep / 10000**
- **>90% of Meteora pools untradeable**: Fees >5%

### WIRING_OLD.md Rewritten

Changed from academic WBS to practical integration guide:
- Source → Target mapping for all components
- Concrete integration steps
- Verification methods for each piece
- Priority order aligned with 100% local cache goal

### Files to Create

```
src/arb/detector.ts           # Cross-venue arb detection
src/arb/phaseDetector.ts      # Two-phase state machine
src/execute/builders/*.ts     # 5 venue instruction builders
src/routing/graph.ts          # Route enumeration
src/telemetry/features.ts     # ML feature collection
src/snapshot/staleness.ts     # Multi-layer staleness
```

### Priority Order

1. Fee fixes (10 min) — Prevents bad trades
2. Instruction builders (2-4 hrs) — Enables execution
3. Bundle builder (1-2 hrs) — Enables Jito submission
4. Arb detector (2-4 hrs) — Finds opportunities
5. Route discovery (2-4 hrs) — Multi-hop paths

---

**Next Step:** Run capture to populate parsed_swaps with actual_output_amount, then verify fee formulas before proceeding with instruction builders.
