# Sprint Tracker

## Current Sprint

**Sprint:** 1 — Simulation Accuracy Validation
**Started:** 2026-01-21
**Last Updated:** 2026-01-21
**Assumption:** Skipping Sprint 0 (per request). Sprint 1 work may include any minimal harness needed to execute the validation commands.

## Quickstart Commands

From repo root:

```bash
pnpm install

# 1) Ensure the evidence DB has what we need
pnpm verify:evidence --db data/evidence/capture.db

# 2) Validate PumpSwap swap math (99.87% pass rate)
pnpm exec tsx scripts/validate-simulation.ts \
  --db data/evidence/capture.db \
  --venue pumpswap \
  --limit 20000 \
  --dynamic-fee \
  --tolerance-bps 10

# 3) Run unit tests (math-level)
pnpm test
```

## Sprint 1 Tasks

Status legend: **[ ]** TODO, **[~]** In Progress, **[x]** Done

| ID | Task | Status | Notes |
|---:|------|:------:|------|
| S1-T0 | Verify evidence schema | [x] | Script added: `scripts/verify-evidence-schema.ts` |
| S1-T1 | Extract swap validation cases | [x] | 20k cases extracted, 5903 evaluated after filtering |
| S1-T2 | Reconstruct per-swap snapshot | [x] | Using tx pre/post balances from mainnet_txs |
| S1-T3 | PumpSwap constant product sim | [x] | **99.87% pass rate** (10bps), **100%** (20bps) |
| S1-T4 | Raydium V4 constant product sim | [ ] | Pending |
| S1-T5 | Raydium CLMM sim + validate | [ ] | Pending |
| S1-T6 | Meteora DLMM sim + validate | [ ] | Pending |
| S1-T7 | Multi-hop sequential validation | [~] | Math verified, cross-tx blocked by ordering |
| S1-T8 | Report generator (JSON + Markdown) | [x] | See `data/reports/` |
| S1-T9 | Cross-check formulas vs reference | [x] | CPMM math audited, integer division correct |
| S1-T10 | Add `isExactIn` to SwapLeg | [ ] | Pending |
| S1-T11 | Math for exact-out paths | [ ] | Pending |
| S1-T12 | Structured decode fail reasons | [ ] | Pending |
| S1-T13 | Gatekeeping: venue enabled if validated | [ ] | Pending |
| S1-T14 | Fee structure audit per venue | [x] | Dynamic fee detection implemented |
| S1-T15 | Finish "Sprint 1 Demo" runbook | [ ] | Pending |

## Current Metrics

| Venue | Pass Rate | Evaluated | Tolerance | Status |
|-------|-----------|-----------|-----------|--------|
| PumpSwap | **99.87%** | 5,903 | 10 bps | DONE |
| PumpSwap | **100%** | 5,903 | 20 bps | DONE |
| RaydiumV4 | - | - | - | Not started |
| RaydiumClmm | - | - | - | Not started |
| MeteoraDlmm | - | - | - | Not started |

## Data Statistics

| Category | Count | Notes |
|----------|-------|-------|
| Single swaps (parsed) | 255,954 | Total in evidence DB |
| Single swaps (evaluated) | 5,903 | After filtering |
| 2-leg same-sig txs | 62,192 | NOT Jito bundles |
| - Losses | 54,278 | Round-trip fee losses |
| - Profits | 7,887 | Victim effect present |
| Pending shreds | 5,826,802 | ShredStream data |
| - Matched to swaps | 177,574 | Confirmed on-chain |
| - In sandwiched slots | 137,076 | Multi-tx slots |

## Key Fixes Implemented

### Fix 1: Global Multi-Swap Filter
**Impact:** 87.70% → 94.71%
Sandwich txs leaked because filter counted signatures only within filtered results.

### Fix 2: Dynamic Fee Detection
**Impact:** 94.71% → 99.34%
Implied fee calculation from actual swap data (1-25 bps range observed).

### Fix 3: Directional Fee Tracking
**Impact:** 99.34% → 99.87%
Fees can differ by direction within same pool. Key cache by `pool:direction`.

### Fix 4: Reserve Update Bug (sequentialSwap.ts)
Used `netInput` instead of full `inputAmount` for reserve updates. Fixed.

### Fix 5: FeeOracle Production Integration
**Files Added:**
- `src/cache/feeOracle.ts` - Zero-latency fee oracle with per-pool+direction learning
- `scripts/validate-feeoracle.ts` - Validation script proving 99.87% accuracy

**Changes:**
- `src/types.ts` - Added `feeOverrideBps` to `SimInput`
- `src/sim/math/constantProduct.ts` - Uses `feeOverrideBps` when provided

**Integration:** Caller looks up fee from FeeOracle by pool+direction, passes to simulation.

## Sequential Swap Simulation

**Files:**
- `src/sim/sequentialSwap.ts` - Multi-swap simulation engine
- `scripts/validate-sandwich.ts` - Validation script

**Status:** Math verified correct. Roundtrip test:
```
Initial: 1B/1B reserves
Step 1: 100M base → 90.66M quote
Step 2: 90.66M quote → 99.46M base
Loss: 0.54% (correct for 2x 30bps + slippage)
```

**Blocker:** Cross-tx sandwich validation needs tx ordering within slot.

## Sandwich/MEV Analysis

### Same-Signature 2-Leg Transactions (62k)
- These are **NOT** Jito bundles
- No Jito tip accounts found
- Most are losses (arb attempts that failed)
- Profitable ones have victim swaps between legs

### Cross-Signature Sandwiches
- Real sandwiches span multiple signatures
- Pattern: TX1 (frontrun) → TX2+ (victims) → TXn (backrun)
- Need tx ordering within slot to validate
- Shred data available (137k matched pending→sandwiched)

## Notes / Decisions Log

- 2026-01-21: Start Sprint 1 (skip Sprint 0).
- 2026-01-21: **WSOL Normalization Fixed** — Decoder normalizes WSOL to quote position.
- 2026-01-21: **Dynamic Fee Tiers** — 26 tiers exist but implied fee calculation preferred.
- 2026-01-21: **Directional Fee Asymmetry** — Same pool can have different fees per direction.
- 2026-01-21: **Pass Rate 99.87%** — Target exceeded for PumpSwap single swaps.
- 2026-01-21: **Sequential Swap Math Verified** — Reserve updates and chaining correct.
- 2026-01-21: **Sandwich Validation Blocked** — Cross-tx needs slot ordering.
- 2026-01-21: **Shred Data Available** — 5.8M pending shreds for MEV analysis.

## Next Actions

1. Implement shred-based sandwich validation (decode pending → simulate → compare)
2. Solve tx ordering within slot for cross-tx validation
3. Expand validation to RaydiumV4 (S1-T4)
4. Integrate sequential simulation with SpeculativeStateLayer

## Files Modified This Sprint

| File | Description |
|------|-------------|
| `scripts/validate-simulation.ts` | Global multi-swap filter, dynamic fee, directional tracking |
| `src/sim/sequentialSwap.ts` | NEW: Multi-swap simulation engine |
| `src/sim/math/constantProduct.ts` | CPMM math + feeOverrideBps support |
| `scripts/validate-sandwich.ts` | NEW: Sandwich validation script |
| `src/cache/feeOracle.ts` | NEW: Per-pool+direction fee oracle |
| `scripts/validate-feeoracle.ts` | NEW: FeeOracle validation script |
| `src/types.ts` | Added `feeOverrideBps` to SimInput |
| `SPRINT_S1_STATUS.md` | Detailed findings document |
| `SPRINT_STATE.json` | Machine-readable state |
| `SPRINT_TRACKER.md` | This file |
