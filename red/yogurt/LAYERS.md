# Infrastructure Layers

This document defines each layer of the infrastructure. Use this as the authoritative reference for what each layer does, what belongs in it, and what the current status is.

**Important**: Each layer must be proven reliable before proceeding to the next. Do not skip ahead. Do not make assumptions about completeness.

---

## Layer 1: Local Cache State

### Purpose
Provide zero-latency mainnet state parity that serves as the single source of truth for all downstream operations.

### CRITICAL: Layer 1 Has TWO Independent Sub-Components

**Layer 1 is NOT a single thing.** It consists of two distinct, independent sub-components:

| Sub-Component | Purpose | Key Files |
|---------------|---------|-----------|
| **Data Pipeline** | Get and store state from chain | `src/ingest/`, `src/decode/programs/decode*Pool()`, `src/cache/` |
| **Math Engines** | Calculate swap outputs given state | `src/sim/math/*.ts` |

**These are INDEPENDENT:**
- You can have correct math but wrong/missing cache data
- You can have correct cache data but wrong math
- A fix to one does NOT fix the other
- Both must be validated separately

**Why This Matters:**

If a feature (e.g., PS-002 dynamic fees) requires a new field (e.g., `baseMintSupply`):
1. The **Data Pipeline** must be able to fetch and store that field
2. The **Math Engines** must use that field correctly
3. Layer 2 must validate BOTH:
   - That the cache gets populated with the field
   - That the math produces correct output using that field

**Current Proving Script Limitation:**

The proving script (`prove-infrastructure.ts`) currently:
- Uses raw transaction data (pre/post token balances) as ground truth for reserves
- Tests math by comparing calculated output to actual output
- Does **NOT** test that our cache would have the correct data

This means: **Proving script success does NOT prove cache population works.**

If you implement a feature that requires new cache data, you must ALSO verify the data pipeline can provide that data. The proving script alone is not sufficient.

### What It Contains
- **Pool Decoders**: Parse account data into structured state (per-venue: PumpSwap, RaydiumV4, RaydiumClmm, MeteoraDlmm)
- **Caches**: Store decoded state (poolCache, vaultCache, tickCache, binCache, configCache)
- **Lifecycle**: Manage pool state transitions (DISCOVERED → FROZEN → ACTIVE)
- **Math Engines**: Calculate swap outputs (CPMM, CLMM, DLMM formulas)

**Important Distinction - Two Types of Decoders:**
| Decoder Type | Layer | Input | Output | Example |
|--------------|-------|-------|--------|---------|
| **Pool Decoders** | Layer 1 | Account data (from gRPC) | Pool state (cached) | `decodePumpSwapPool()` |
| **Instruction Decoders** | Layer 2/3 | Transaction instructions | SwapLeg (not cached) | `decodePumpSwapInstruction()` |

Pool decoders populate the cache. Instruction decoders parse transactions for evidence capture (Layer 2) and victim transaction analysis (Layer 3). Both live in `src/decode/programs/*.ts` but serve different purposes.

### What It Does
- Receives confirmed account changes via gRPC (Yellowstone)
- Uses **pool decoders** to parse account data into structured pool/vault/tick/bin state
- Stores state in typed caches
- Manages pool lifecycle and RPC containment (after FROZEN, only gRPC can update)
- Provides math formulas for calculating swap outputs

### What It Does NOT Do
- Does NOT perform any profit calculations
- Does NOT build or submit transactions
- Does NOT handle pending/unconfirmed transactions
- Does NOT predict future state

### Cache Validation Status

| Venue | Cache Validation | Report |
|-------|------------------|--------|
| PumpSwap | **VALIDATED** | `docs/validation/LOCAL_CACHE_VALIDATION.md` |
| RaydiumV4 | **VALIDATED** | `docs/validation/LOCAL_CACHE_VALIDATION.md` |
| RaydiumClmm | NOT_TESTED | - |
| MeteoraDlmm | **VALIDATED** | `data/evidence/prove-dlmm-l2-*.json` |

### Current Reality
**Layer 1 infrastructure EXISTS but has GAPS.** The gaps are:
- Pool decoders: WSOL normalization fixed, working correctly
- Instruction decoders: WSOL normalization fixed (PS-001)
- Fee resolution: PumpSwap dynamic tiers (26 levels) not yet implemented (PS-002)
- Math may have edge cases not yet discovered
- Coverage across all venues is not yet proven

**This is expected.** The purpose of Layer 2 is to identify and fix these gaps. Do not assume Layer 1 is complete or correct until Layer 2 proves it.

### Key Files
| File | Purpose |
|------|---------|
| `src/handler/phase3.ts` | Main entry point, routes gRPC events to pool decoders and caches |
| `src/ingest/grpc.ts` | gRPC consumer, receives confirmed account updates |
| `src/decode/programs/*.ts` | Per-venue decoders (contains BOTH pool decoders and instruction decoders) |
| `src/cache/*.ts` | Typed caches (pool, vault, tick, bin, ammConfig, globalConfig) |
| `src/cache/commit.ts` | Single entry point for all cache mutations |
| `src/cache/lifecycle.ts` | Pool state machine, RPC containment |
| `src/sim/math/constantProduct.ts` | CPMM math (PumpSwap, RaydiumV4) |
| `src/sim/math/clmm.ts` | Concentrated liquidity math (RaydiumClmm) |
| `src/sim/math/dlmm.ts` | Dynamic liquidity math (MeteoraDlmm) |

**Note on `src/decode/programs/*.ts`:** These files contain TWO types of functions:
- `decode*Pool()` - Pool decoders (Layer 1, populates cache)
- `decode*Instruction()` - Instruction decoders (Layer 2/3, parses transactions)

### Supported Venues
| Venue | Program ID | Math Type | Layer 1 Status |
|-------|------------|-----------|----------------|
| PumpSwap | `pAMMBay...` | Constant Product | Has gaps (fees, directions) |
| RaydiumV4 | `675kPX...` | Constant Product | Not yet proven |
| RaydiumClmm | `CAMMCz...` | Concentrated Liquidity | Not yet proven |
| MeteoraDlmm | `LBUZKh...` | Dynamic Liquidity | Not yet proven |

---

## Layer 2: Proving Tools

### Purpose
Identify gaps in Layer 1, fix them in Layer 1 directly, and prove the fixes work using real on-chain data.

### What It Does
- Captures real transaction data from mainnet (pre/post state)
- Runs Layer 1 math against captured data
- Compares infrastructure output to actual on-chain output
- Identifies discrepancies (gaps) in Layer 1
- After fixing Layer 1, re-runs to prove the fix works
- Iterates until 100% accuracy is achieved

### What It Does NOT Do
- Does NOT run on the hot path
- Does NOT affect production execution
- Does NOT build or submit transactions
- Does NOT calculate profitability
- Does NOT create workarounds that bypass Layer 1

### Critical Rule: NO BANDAIDS

**Workarounds are unacceptable.** If Layer 2 identifies a gap (e.g., fees are wrong), the fix MUST be applied to Layer 1 infrastructure. Creating a workaround that makes the proving script pass without fixing Layer 1 is:
- A false positive
- Unacceptable
- Grounds for reverting the change

Examples of unacceptable approaches:
- Learning fees at runtime from observed swaps instead of fixing fee resolution in Layer 1
- Skipping transactions that fail instead of understanding why they fail
- Adding tolerances that mask real errors
- Adding filters to exclude failing transactions to inflate pass rate

### Anti-Patterns (DO NOT DO)

**1. Filters that inflate pass rate**

Filters in `prove-infrastructure.ts` are for DETECTING issues, not hiding them.
Every filter identifies a GAP that must be documented.

| If you add a filter for... | You MUST also... |
|----------------------------|------------------|
| Multi-swap transactions | Document as gap, assess Layer 3 impact |
| Dust trades | Document as limitation, explain why acceptable |
| Extreme reserve ratios | Document as unsupported pool type |
| Any failure class | Investigate root cause before filtering |

The "true pass rate" is measured with ALL filters disabled (`--all-swaps`).

**2. "95% is good enough" without understanding the 5%**

Every failure must be categorized:
- Is it a Layer 1 bug? → Fix it
- Is it a proving methodology bug? → Fix the proving script
- Is it out of scope? → Document explicitly with rationale
- Unknown? → Mark as "NEEDS INVESTIGATION"

**3. Declaring COMPLETE while gaps remain**

Status is IN PROGRESS until all gaps are either:
- Fixed in Layer 1
- Fixed in proving methodology
- Documented as explicit limitations with Layer 3 impact assessed

### Required Validation Outputs

For each program, Layer 2 MUST produce a validation report (`docs/validation/{PROGRAM}_L2.md`) containing:

| Section | Content |
|---------|---------|
| **Raw Metrics** | Pass rate with NO filters applied |
| **Gap Inventory** | Every skip/filter = a gap to document |
| **Root Cause Analysis** | Why each gap exists |
| **Layer 3 Impact** | What opportunities are affected |
| **Proven Capabilities** | What Layer 1 CAN do reliably |
| **Unproven Capabilities** | What's NOT tested |
| **Layer 3 Readiness** | Can we execute with confidence? |
| **Prioritized Actions** | Ordered by Layer 3 impact |

### Coverage vs Reliability: Both Are Required

**The goal is 100% coverage at 100% reliability.**

If we can't achieve that:
1. Understand exactly what we CAN'T cover (quantify it)
2. Understand WHY (root cause)
3. Assess Layer 3 impact (what opportunities are we missing?)
4. Make explicit decision to accept limitation (not hide it)

**Wrong approach:** "We have 95% pass rate, let's move on"
**Right approach:** "We have 95% pass rate on single-swap. Multi-swap is 0% (broken proving). Data pipeline untested. Here are the gaps and their Layer 3 impact."

### Validation Report Template

See `docs/validation/PUMPSWAP_L2.md` for the canonical example of a proper validation report.

### Key Files
| File | Purpose |
|------|---------|
| `scripts/capture-evidence.ts` | Records mainnet data to SQLite for analysis |
| `scripts/prove-infrastructure.ts` | Compares Layer 1 output to on-chain results |
| `data/evidence/capture.db` | SQLite database containing captured evidence |
| `src/decode/programs/*.ts` | **Instruction decoders** used here to parse swap transactions |
| `src/decode/swap.ts` | `extractSwapLegs()` - extracts all swap legs from a transaction |

**Note:** Layer 2 uses **instruction decoders** (not pool decoders) to parse confirmed transactions and extract swap details for evidence capture.

### Proving Process
For each venue:
1. Capture real swaps with pre/post transaction state
2. Run Layer 1 math with pre-transaction state as input
3. Compare output to actual post-transaction output
4. If mismatch: identify root cause in Layer 1, fix Layer 1, re-run
5. Repeat until 100% accuracy (or operator decides to move on)

### Completion Criteria
A venue is proven when Layer 1 infrastructure:
- Math produces output within acceptable tolerance (operator-defined)
- Decoders correctly parse all instruction types
- Fees are correctly resolved IN LAYER 1 (not via workarounds)
- Directions are correctly normalized IN LAYER 1
- Tick/bin traversal is correct (for CLMM/DLMM)
- Multi-transaction patterns are handled (if achievable)

### Current Work
This is where active development is focused. See `CURRENT_STATE.json` for specific task status.

### Status
PumpSwap, RaydiumV4, MeteoraDlmm proven. RaydiumClmm not started.

---

## Layer 3: Execution Pipeline

### Purpose
Detect profitable opportunities and execute them via Jito bundles.

### What It Does
- Uses **instruction decoders** to decode incoming shreds (pending transactions)
- Identifies patterns that represent profitable opportunities (e.g., large victim swaps)
- Calculates expected profit using Layer 1 math engines (reads cache, never writes)
- Builds swap instructions per venue
- Assembles V0 transactions with compute budget
- Builds Jito bundles with tip transactions
- Submits bundles to Jito block engine
- Tracks results

### What It Does NOT Do
- Does NOT mutate Layer 1 cache (reads only)
- Does NOT store persistent state
- Does NOT handle prediction of future state (that is Layer 4)

### Key Files
| File | Purpose |
|------|---------|
| `src/execute/backrun.ts` | Backrun detection + execution engine (cross-venue + legacy CPMM) |
| `src/execute/bundle.ts` | Bundle construction (PumpSwap, RaydiumV4, MeteoraDlmm) |
| `src/execute/submit.ts` | Jito submission with retry and result tracking |
| `src/execute/pairIndex.ts` | O(1) cross-venue counterpart lookup |
| `scripts/run-backrun.ts` | Runtime entrypoint (config, lifecycle, telemetry) |
| `src/decode/programs/*.ts` | **Instruction decoders** - used to decode victim transactions from shreds |
| `src/decode/swap.ts` | `extractSwapLegs()` - extracts swap details from pending transactions |

**Note:** Layer 3 uses **instruction decoders** to understand what victims are doing. The decoded SwapLeg tells us: direction, input amount, pool. We then use Layer 1 cache state + math to calculate our counter-move.

### Strategies to Support
- Backrunning (follow victim swap with profitable counter-swap)
- Sandwich (frontrun + backrun around victim)
- Cross-venue arbitrage (price discrepancy between venues)
- Multi-hop arbitrage (A→B→C→A within same venue)
- JIT liquidity (provide liquidity just-in-time)
- Fee extraction (capture fees from inefficient routes)

### Prerequisites
Layer 1 must be proven reliable via Layer 2 before Layer 3 development begins.

### Status
In progress. cross_venue_ps_dlmm strategy functional end-to-end. Execution correctness blockers prevent landed bundles (token program mismatch in bundle construction). See CURRENT_STATE.json for specific blockers.

---

## Layer 4: Prediction Layer

### Purpose
Predict future state by applying pending (unconfirmed) transactions to a copy of Layer 1 state.

### What It Does
- Receives pending transactions from ShredStream
- Decodes and orders pending transactions
- Applies predicted impact to a SEPARATE state copy (never touches Layer 1)
- Provides predicted post-pending state for more accurate opportunity evaluation

### What It Does NOT Do
- Does NOT mutate Layer 1 cache
- Does NOT guarantee prediction accuracy (shreds are unordered, may not confirm)
- Does NOT replace Layer 1 as source of truth

### Key Files (Partially Implemented)
| File | Purpose |
|------|---------|
| `src/ingest/shred.ts` | ShredStream consumer (implemented) |
| `src/pending/queue.ts` | Pending transaction queue (implemented) |
| `src/pending/speculative.ts` | Speculative state overlay (implemented) |

### Challenges
- Shreds are unordered (must determine execution order)
- Pending transactions may not confirm
- State copy must be kept in sync with Layer 1 confirmed state

### Prerequisites
1. Layer 3 must be operational
2. Feasibility must be confirmed before significant investment

### Status
Feasibility not confirmed. Some infrastructure exists but not proven or integrated. Do not invest significant time until feasibility is validated.

---

## Layer Progression Rules

1. **Do not skip layers.** Each layer depends on the one below it.

2. **Prove before proceeding.** Layer 1 must be proven reliable before Layer 3 development.

3. **No bandaids.** Fixes must be applied to Layer 1 directly. Workarounds that inflate metrics are unacceptable.

4. **100% is the goal.** Aim for 100% accuracy and coverage. Partial solutions are acceptable only when the operator explicitly approves.

5. **Real data is ground truth.** On-chain transaction results are the only acceptable source of truth for proving infrastructure.

6. **No assumptions.** Do not assume something works. Prove it with evidence.

7. **No hallucinations.** If uncertain, ask. Do not fabricate information about status or capabilities.

8. **Operator decides.** The operator decides when to move on from a venue or problem. "It's hard" is not a reason to move on.
