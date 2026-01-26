# Mental Map

This document captures the architectural design, data flow, and strategic rationale for this MEV/arbitrage infrastructure.

---

## Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DATA SOURCES                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │  gRPC Stream    │    │  RPC Bootstrap  │    │  ShredStream    │         │
│  │  (Yellowstone)  │    │  (One-time)     │    │  (Pending TXs)  │         │
│  │                 │    │                 │    │                 │         │
│  │  - Confirmed    │    │  - Tick arrays  │    │  - Unconfirmed  │         │
│  │    account      │    │  - Bin arrays   │    │  - Faster than  │         │
│  │    changes      │    │  - AmmConfig    │    │    confirmed    │         │
│  │  - Lowest       │    │  - Initial      │    │  - Unordered    │         │
│  │    latency for  │    │    vault state  │    │                 │         │
│  │    confirmed    │    │                 │    │                 │         │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘         │
│           │                      │                      │                   │
└───────────┼──────────────────────┼──────────────────────┼───────────────────┘
            │                      │                      │
            ▼                      ▼                      │
┌─────────────────────────────────────────────────────────┼───────────────────┐
│                    LAYER 1: LOCAL CACHE STATE           │                   │
│                    (Source of Truth)                    │                   │
├─────────────────────────────────────────────────────────┼───────────────────┤
│                                                         │                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │                   │
│  │Pool Decoders│    │   Caches    │    │  Lifecycle  │ │                   │
│  │(Layer 1)    │    │             │    │             │ │                   │
│  │ - PumpSwap  │    │ - poolCache │    │ - DISCOVERED│ │                   │
│  │ - RaydiumV4 │───▶│ - vaultCache│    │ - FROZEN    │ │                   │
│  │ - RaydiumCLMM    │ - tickCache │    │ - ACTIVE    │ │                   │
│  │ - MeteoraDLMM    │ - binCache  │    │             │ │                   │
│  │             │    │ - configCache    │ After FROZEN│ │                   │
│  └─────────────┘    └─────────────┘    │ RPC blocked │ │                   │
│                                        │ gRPC only   │ │                   │
│  ┌─────────────┐                       └─────────────┘ │                   │
│  │ Math Engines│                                       │                   │
│  │             │                                       │                   │
│  │ - CPMM      │  These calculate swap outputs.       │                   │
│  │ - CLMM      │  They are Layer 1 infrastructure.    │                   │
│  │ - DLMM      │  Layer 2 proves they are correct.    │                   │
│  └─────────────┘  Layer 3 uses them for execution.    │                   │
│                                                         │                   │
│  This layer provides:                                   │                   │
│  - Zero-latency mainnet state parity                   │                   │
│  - Source of truth for all downstream operations       │                   │
│  - Eliminates RPC calls on hot path                    │                   │
│                                                         │                   │
│  CURRENT REALITY: Infrastructure exists but has gaps.  │                   │
│  Layer 2 identifies and fixes these gaps.              │                   │
│                                                         │                   │
│  NEVER MUTATED BY EXECUTION PIPELINE                   │                   │
│                                                         │                   │
└─────────────────────────────────────────────────────────┼───────────────────┘
                                                          │
            ┌─────────────────────────────────────────────┘
            │
            ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 2: PROVING TOOLS                                     │
│                    (Identifies and Fixes Layer 1 Gaps)                        │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────┐    ┌─────────────────────┐                          │
│  │ capture-evidence.ts │    │prove-infrastructure.ts                         │
│  │                     │    │                     │                          │
│  │  - Records gRPC     │    │  - Uses evidence DB │                          │
│  │    updates          │    │  - Compares pre/post│                          │
│  │  - Records txs      │    │    transaction state│                          │
│  │  - Records shreds   │    │  - Identifies gaps  │                          │
│  │  - Records swaps    │    │    in Layer 1       │                          │
│  │  - NOT on hot path  │    │  - Proves fixes work│                          │
│  │                     │    │  - No workarounds   │                          │
│  └─────────────────────┘    └─────────────────────┘                          │
│                                                                               │
│  Purpose: Identify gaps in Layer 1, fix them, prove fixes work               │
│  Method: Real on-chain data as ground truth                                  │
│  Rule: NO BANDAIDS. Fix Layer 1 infrastructure directly.                     │
│  Rule: Workarounds that inflate metrics are unacceptable.                    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
            │
            │ (Layer 1 must be proven before proceeding)
            ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 3: EXECUTION PIPELINE                                │
│                    (Future - Not Started)                                     │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │  Opportunity │   │    Profit    │   │    Bundle    │   │     Jito     │  │
│  │  Detection   │──▶│  Calculation │──▶│   Building   │──▶│  Submission  │  │
│  │              │   │              │   │              │   │              │  │
│  │  - Decode    │   │  - Use math  │   │  - Per-venue │   │  - Tip calc  │  │
│  │    shreds    │   │    engines   │   │    instruction   │  - Submit    │  │
│  │  - Identify  │   │  - Compare   │   │    builders  │   │  - Track     │  │
│  │    profitable│   │    to costs  │   │  - V0 message│   │    result    │  │
│  │    patterns  │   │  - Filter    │   │  - Sign      │   │              │  │
│  └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘  │
│                                                                               │
│  READS from Layer 1 cache - NEVER WRITES                                     │
│  Strategies: Backrun, Sandwich, Cross-venue arb, Multi-hop arb, JIT, etc.   │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
            │
            │ (Requires feasibility confirmation before investment)
            ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 4: PREDICTION LAYER                                  │
│                    (Future - Requires Feasibility Check)                      │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                    Predicted Impact State                            │     │
│  │                    (Parallel to Layer 1 - Never touches it)          │     │
│  │                                                                      │     │
│  │  ShredStream ──▶ Decode ──▶ Order ──▶ Apply to copy of state        │     │
│  │                                                                      │     │
│  │  Purpose: Predict what state WILL BE after pending txs confirm      │     │
│  │  Challenge: Shreds are unordered, confirmation not guaranteed       │     │
│  │  Value: Earlier opportunity detection, better profit estimation     │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
│  STATUS: Not started. Feasibility must be confirmed before investing time.  │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Important: Two Types of Decoders

The codebase has TWO types of decoders in `src/decode/programs/*.ts`:

| Decoder Type | Function Pattern | Layer | Purpose | Populates Cache? |
|--------------|------------------|-------|---------|------------------|
| **Pool Decoders** | `decode*Pool()` | Layer 1 | Parse account data → pool state | ✅ Yes |
| **Instruction Decoders** | `decode*Instruction()` | Layer 2/3 | Parse transaction instructions → SwapLeg | ❌ No |

**Pool Decoders (Layer 1):**
- Input: Account data from gRPC
- Output: Structured pool state (PumpSwapPool, RaydiumV4Pool, etc.)
- Used by: Cache population (Layer 1)
- Example: `decodePumpSwapPool()` parses pool account → populates poolCache

**Instruction Decoders (Layer 2/3):**
- Input: Transaction instructions (from confirmed txs or shreds)
- Output: SwapLeg (direction, amounts, pool, mints)
- Used by: Evidence capture (Layer 2), Opportunity detection (Layer 3)
- Example: `decodePumpSwapInstruction()` parses swap instruction → tells us what victim is doing

This distinction matters because:
1. Pool decoders affect cache state (source of truth)
2. Instruction decoders affect how we understand transactions (evidence capture, victim analysis)
3. Bugs in pool decoders break Layer 1 math
4. Bugs in instruction decoders break evidence capture and execution decisions

---

## CRITICAL: Layer 1 Sub-Components

**Layer 1 consists of TWO independent sub-components that must be validated separately:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         LAYER 1: TWO INDEPENDENT PARTS                        │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  SUB-COMPONENT A: DATA PIPELINE                                         │ │
│  │  Purpose: Get and store state from chain                                │ │
│  │                                                                         │ │
│  │  gRPC ──▶ Pool Decoders ──▶ Caches ──▶ Pool State                      │ │
│  │                                                                         │ │
│  │  Key files: src/ingest/, src/decode/programs/decode*Pool(), src/cache/ │ │
│  │  Outputs: poolCache, vaultCache, tickCache, binCache, configCache      │ │
│  │                                                                         │ │
│  │  WHAT CAN GO WRONG:                                                    │ │
│  │  - gRPC not subscribed to required accounts                            │ │
│  │  - Decoder doesn't extract required fields                             │ │
│  │  - Cache doesn't store required fields                                 │ │
│  │  - Data not populated at the right time                                │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  SUB-COMPONENT B: MATH ENGINES                                          │ │
│  │  Purpose: Calculate swap outputs given state                            │ │
│  │                                                                         │ │
│  │  Pool State ──▶ Math Functions ──▶ Swap Output                         │ │
│  │                                                                         │ │
│  │  Key files: src/sim/math/constantProduct.ts, clmm.ts, dlmm.ts          │ │
│  │  Functions: getAmountOut(), getAmountIn(), simulateSwap()              │ │
│  │                                                                         │ │
│  │  WHAT CAN GO WRONG:                                                    │ │
│  │  - Wrong formula                                                        │ │
│  │  - Wrong fee calculation                                                │ │
│  │  - Wrong rounding                                                       │ │
│  │  - Missing edge cases                                                   │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  THESE ARE INDEPENDENT:                                                       │
│  - Correct math with wrong/missing cache data = BROKEN                       │
│  - Correct cache data with wrong math = BROKEN                               │
│  - Both must be validated separately                                          │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Validation Requirements

When implementing a feature that requires new data (e.g., PS-002 dynamic fees need `baseMintSupply`):

| Step | What to Validate | How to Validate |
|------|------------------|-----------------|
| 1 | Can the Data Pipeline get this data? | Check gRPC subscription, decoder, cache |
| 2 | Does the cache store this data? | Inspect cache after capture run |
| 3 | Does the math use this data correctly? | Proving script with correct inputs |
| 4 | Does the full path work end-to-end? | Run with real cache, not extracted tx data |

### Current Proving Script Limitation

The proving script (`prove-infrastructure.ts`) currently:
- Extracts reserves from transaction metadata (pre/post token balances)
- Runs math against this extracted data
- Compares output to actual on-chain output

This tests the MATH, but NOT the DATA PIPELINE.

**If you implement a feature that needs new cache data:**
1. Proving script success does NOT mean the cache will have this data in production
2. You must separately verify the data pipeline can provide the data
3. Otherwise you've built math that works in tests but fails in production

---

## Layer 2 Output Artifacts

Layer 2 is not just "run prove-infrastructure.ts and check pass rate."

### Required Outputs Per Program

| Artifact | Location | Purpose |
|----------|----------|---------|
| Validation Report | `docs/validation/{PROGRAM}_L2.md` | Complete gap analysis |
| Gap Inventory | In validation report | Every issue found |
| Layer 3 Readiness | In validation report | Can we execute? |
| Priority Actions | In CURRENT_STATE.json | What to fix next |

### The Filter Trap

**Filters in prove-infrastructure.ts are DETECTION tools, not solutions.**

When you see a filter being added, ask:
1. What class of transactions does this filter exclude?
2. What percentage of total volume?
3. What's the Layer 3 impact? (What opportunities are we missing?)
4. Can we fix Layer 1 to handle these, or is it truly out of scope?

**Example of the trap:**

| Metric | With Filters | Without Filters |
|--------|--------------|-----------------|
| Pass Rate | 97.91% | 95.98% |
| Evaluated | 33,797 | 50,027 |
| Hidden failures | 1,305 | 0 |

The filters made it LOOK better without fixing anything.

### Coverage Is Critical

Multi-swap transactions are 38.7% of PumpSwap volume. If Layer 3 can't handle them, we're blind to 38.7% of opportunities. This is NOT acceptable.

**The goal: 100% coverage at 100% reliability**

If we accept less:
- Quantify exactly what we're missing
- Understand WHY we can't cover it
- Assess impact on Layer 3 opportunity detection
- Make explicit decision with operator

---

## Strategic Rationale

### Is Local Cache State a Legitimate Competitive Advantage?

**Yes, but with important caveats.**

#### What Top MEV Operators Have:
- Colocation with validators (same data center)
- Direct fiber connections to block producers
- Custom hardware and proprietary feeds
- Sub-millisecond round-trip times

#### What This Infrastructure Has:
- gRPC confirmed stream (fastest publicly available confirmed state)
- ShredStream (pending txs - faster than confirmed but unordered)
- Local cache (eliminates per-opportunity RPC calls)
- Home server with solid specs (residential internet latency)

#### Where This Approach Excels:

| Strategy | Why Local Cache Helps | Competition Level |
|----------|----------------------|-------------------|
| **Backrunning** | Don't need to be first, need to be in same Jito bundle as victim | Moderate |
| **Less contested pairs** | Long-tail tokens, new pools - fewer competitors watching | Lower |
| **Complex multi-hop arb** | More computation required, local state enables parallel evaluation | Lower |
| **Cross-venue arb** | Need state from multiple venues simultaneously | Moderate |

#### Where This Approach Will Struggle:

| Strategy | Why | Competition Level |
|----------|-----|-------------------|
| **Pure speed races** | Colocation always wins | Extreme |
| **Simple single-hop arb on SOL/USDC** | Everyone is watching | Extreme |
| **Frontrunning** | Need to see AND act before colocated operators | Extreme |

#### The Real Competitive Advantage:

It is NOT raw speed. It is:

1. **Reliability**: 100% accurate state means confident execution, no failed bundles due to stale state
2. **Coverage**: Can evaluate opportunities across ALL venues simultaneously
3. **Strategy selection**: Target less contested opportunities that colocated operators ignore (too small for them, perfect for this system)
4. **Cost efficiency**: No colocation costs means profitable at lower margins
5. **Flexibility**: Can pivot strategies without infrastructure changes

#### Target Profitability:

The ecosystem captures approximately $500K-2M/day in MEV on Solana. This system does not need to compete for the majority. It needs to capture a sliver that the big players leave on the table or don't prioritize.

Initial target: >15 SOL/day
Strategy: Backrun opportunities, less contested pairs, complex multi-hop where computation matters

---

## Core Principle

The local cache state as source of truth, eliminating RPC latency, with reliable math and decoders - this IS the right foundation. The key is targeting the right opportunities for the infrastructure constraints.

---

## Hardware Specifications

- CPU: AMD Threadripper (24 cores, 48 threads)
- RAM: 512 GB
- Storage: 3x NVMe SSD
- Network: x540-10gb NIC
- GPU: RTX 5070 12GB PCIe 5.0
- Location: Personal residence (no colocation)
- Internet: Residential (not direct fiber)

These constraints inform strategy selection. Speed races are not viable. Reliability and computation-heavy strategies are the competitive advantage.
