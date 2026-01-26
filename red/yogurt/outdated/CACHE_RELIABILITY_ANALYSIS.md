# Cache Reliability Analysis

## What Actually Happened

After 2 weeks of validation showing "100% cache reliability," we discovered that:

1. **The cache infrastructure IS reliable** - gRPC streams, slot ordering, RPC containment, lifecycle management all work correctly
2. **The decoder had a semantic bug** - some PumpSwap pools store WSOL in the "base" position, and our decoder wasn't normalizing this
3. **Our validation tested plumbing, not semantics** - we proved data flows correctly, but never proved the decoded data was *meaningful*

---

## The Two Layers of "Correctness"

### Layer 1: Infrastructure (Cache Plumbing)
```
gRPC bytes → Handler → Decoder → Cache → Snapshot
     ↓           ↓         ↓        ↓         ↓
   ✅ recv    ✅ route   ???     ✅ store  ✅ assemble
```

**What we validated for 2 weeks:**
- Slot consistency across dependencies
- RPC blocked after freeze (lifecycle)
- gRPC stream health
- Update flow through pipeline
- No stale data overwrites

**Verdict: Infrastructure is SOUND.**

### Layer 2: Semantics (Decoder Correctness)
```
Raw pool bytes [baseMint=WSOL, quoteMint=TOKEN, baseVault=X, quoteVault=Y]
                                    ↓
                        decodePumpSwapPool()
                                    ↓
              PoolState { baseVault: X, quoteVault: Y }  ← WRONG if WSOL should be quote
```

**What we never validated:**
- Do decoded vault assignments match semantic expectations?
- Does simulation output match on-chain swap outcomes?
- Are the reserve values correct for CPMM math?

**Verdict: Decoder semantics were UNTESTED.**

---

## Why This Matters

### The Cache Stores What The Decoder Produces

```
                     Raw gRPC Bytes (CORRECT)
                              ↓
                    decodePumpSwapPool()
                              ↓
                    PoolState with baseVault/quoteVault
                              ↓
                         PoolCache
                              ↓
                       buildSnapshot()
                              ↓
                    Simulation uses reserves
```

If the decoder outputs semantically wrong data:
- Cache stores wrong data (correctly, per infrastructure)
- Snapshot assembles wrong reserves (correctly, per infrastructure)
- Simulation produces wrong outputs (garbage in, garbage out)

**The cache is doing its job perfectly - storing exactly what the decoder tells it to store.**

---

## Impact Assessment

### What's Broken
- PumpSwap pools with WSOL-in-base position have inverted vault assignments
- Simulation for those pools uses wrong reserves
- Any predictions/backrun calculations for those pools are wrong

### What's NOT Broken
- Cache infrastructure (lifecycle, slot ordering, RPC containment)
- gRPC streaming
- Vault balance updates (keyed by actual address, not "base"/"quote")
- The simulation math itself (CPMM formula is correct)

### Severity: MEDIUM
- Not catastrophic: infrastructure is sound, only decoder needs fixing
- Not trivial: any pool with WSOL-in-base was producing wrong simulations
- Fixable: decoder normalization is a one-line fix per edge case

---

## Current Testing Strategy: Is It Right?

### What We're Doing Now (validate-simulation.ts)
```
For each confirmed swap in capture.db:
  1. Get pre/post token balances from transaction (ground truth)
  2. Calculate vault deltas (actual output)
  3. Run CPMM simulation with captured reserves
  4. Compare predicted output vs actual output
  5. If error > 10 bps → FAIL
```

**This IS the correct strategy because:**
- Tests the entire pipeline end-to-end
- Uses on-chain outcomes as ground truth
- Catches decoder bugs, math bugs, fee bugs, everything
- Agnostic to implementation - just "did we predict correctly?"

### Why We Didn't Catch This Earlier
- validate-simulation.ts was created recently (for S1 sprint)
- Previous validation focused on infrastructure, not accuracy
- We assumed "cache matches RPC" meant "cache is correct"
- RPC uses the same decoder → both wrong the same way

---

## The Path to 100% Reliability

### Step 1: Fix All Decoders
For each venue, validate that decoded pool state produces correct simulation outputs:

| Venue | Decoder | Known Issues | Status |
|-------|---------|--------------|--------|
| PumpSwap | pumpswap.ts | WSOL normalization | FIXED |
| PumpSwap | pumpswap.ts | Dynamic fees (25 tiers) | TODO |
| RaydiumV4 | raydiumV4.ts | ? | UNTESTED |
| RaydiumClmm | raydiumClmm.ts | ? | UNTESTED |
| MeteoraDlmm | meteoraDlmm.ts | ? | UNTESTED |

### Step 2: Simulation Accuracy Validation Per Venue
Run validate-simulation.ts (or equivalent) for each venue:
- Target: 99%+ pass rate at 10 bps tolerance
- Investigate every failure - is it decoder, math, or edge case?
- Fix decoder, not simulation (simulation follows on-chain behavior)

### Step 3: Re-Capture Evidence
After decoder fixes:
- Run fresh capture with fixed decoders
- Validate simulation accuracy against new capture
- This proves the live cache will be correct going forward

### Step 4: Add Decoder-Level Validation (Optional)
Consider adding tests that validate decoder output directly:
- Known pool accounts → expected decoded state
- Fuzzing with edge cases (WSOL positions, etc.)
- But end-to-end simulation testing is more valuable

---

## Key Insight: Don't Mold Simulation to Fix Broken Cache

The user's instinct is correct:

> "I don't want to get derailed... making sure that the local cache state is able to be used as the source of truth, without molding the simulation work to work with broken local cache"

**The simulation math should match on-chain behavior exactly.**

If simulation fails, the fix is in the decoder or data, NOT in the simulation logic. The simulation is the *validator* - if you change it to match broken data, you've lost your ground truth.

---

## Conceptual Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GROUND TRUTH                                 │
│                  (On-chain transaction outcomes)                     │
└─────────────────────────────────────────────────────────────────────┘
                                  ↑
                        validate against
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         SIMULATION                                   │
│                    (CPMM/CLMM/DLMM math)                            │
│                                                                      │
│   This should be a pure function: f(reserves, amount, fee) → output │
│   If it doesn't match ground truth, something upstream is wrong     │
└─────────────────────────────────────────────────────────────────────┘
                                  ↑
                            reads from
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         LOCAL CACHE                                  │
│                                                                      │
│   Stores decoded pool state + vault balances                         │
│   Infrastructure is reliable (proven)                                │
│   Decoder correctness must be validated per-venue                    │
└─────────────────────────────────────────────────────────────────────┘
                                  ↑
                           populated by
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         DECODERS                                     │
│                                                                      │
│   Transform raw bytes → semantic PoolState                           │
│   THIS IS WHERE BUGS LIVE                                            │
│   Must handle ALL edge cases (WSOL position, fee tiers, etc.)       │
└─────────────────────────────────────────────────────────────────────┘
                                  ↑
                          receives from
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         gRPC STREAM                                  │
│                                                                      │
│   Raw account bytes from validator                                   │
│   Assumed correct (it's the blockchain)                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Summary

| Question | Answer |
|----------|--------|
| Is the cache infrastructure reliable? | YES - proven over 2 weeks |
| Is the cached data semantically correct? | PARTIALLY - decoder bugs exist |
| Is our testing strategy correct? | YES - simulation vs ground truth |
| Should we change simulation to match broken data? | NO - fix decoders instead |
| Is this a huge deal? | MEDIUM - fixable, not catastrophic |
| What do we do now? | Continue S1, fix decoders, validate all venues |

---

## Action Items

1. **Continue current work** - validate-simulation.ts is the right tool
2. **Fix PumpSwap fees** - implement FeeConfig decoder for dynamic tiers
3. **Expand to all venues** - run simulation validation for RaydiumV4, CLMM, DLMM
4. **Fix any decoder bugs found** - each venue may have edge cases
5. **Re-capture evidence** - after all decoder fixes are in place
6. **Document known edge cases** - for each venue's decoder

The cache infrastructure is solid. The decoders need validation. The testing strategy is correct. Stay the course.
