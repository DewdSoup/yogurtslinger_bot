# Yogurt Pipeline — Work Breakdown Structure v3

## Governance: Evidence-Driven Phase Completion (MANDATORY)

Phase status is not narrative. A phase may be marked **PASS** only when a compliant evidence artifact exists.

Authoritative contract files:
- `.agent/EVIDENCE_CONTRACT.md` (Evidence Contract v3.0)
- `.agent/GATE_REGISTRY.json` (canonical gate IDs and thresholds)

Non-negotiable rules:
- If any required gate ID is missing from evidence, the phase is **UNVALIDATED** (no exceptions)
- Evidence measures **infrastructure capability**, not test harness capability
- If a gate fails, fix the infrastructure (`src/`), not the validation script (`scripts/`)

## Scope Statement

**Objective:** Baseline MEV execution pipeline with 100% local simulation, dual-path data architecture (confirmed + pending), and Jito bundle execution with tip.

**Target Venues:** PumpSwap, Raydium V4, Raydium CLMM, Meteora DLMM

**Latency Targets (Subject to Phase 0.5 Validation):**
- Single-hop: p99 < 1ms (t0→t4)
- Multi-hop: p99 < 2ms (t0→t4)
- *Note: Targets may be adjusted based on Phase 0.5 measurements and Phase 0 opportunity window analysis*

**Accuracy Targets:**
- Simulation vs on-chain execution: ≤0.1% error
- Slot-consistent state: 100% of simulations

**Strategy Interface (Out of Scope Implementation):**
- Opportunity struct must include: venue, path, amountIn, amountOut, profitSOL, gasEstimate, timestamp
- Phase 8 submits ALL opportunities that reach it
- Strategy filtering (profit threshold, risk limits, position sizing) implemented OUTSIDE this pipeline
- Strategy logic consumes opportunities from Phase 8 output

**Out of Scope:** Strategy decision logic, token classification, RPC simulation, analytics in hotpath, multi-bundle submission, connection pooling

---

## Phase Dependencies

```
Phase 0 (Evidence) ─┐
                    ├─→ Phase 0.5 (Baseline) ─┐
                    │                          │
                    └──────────────────────────┴─→ Phase 1 (Ingest) ─→ Phase 1.5 (Recovery) ─→ Phase 2 (Cache) ─→ Phase 3 (Snapshot) ─┐
                                                                                                                                        │
                                                                                                                                        ├─→ Phase 4 (Pending) ─┐
                                                                                                                                        │                      │
                                                                                                                                        └──────────────────────┴─→ Phase 5 (Simulation) ─→ Phase 6 (Errors) ─→ Phase 7 (Latency) ─→ Phase 8 (Execution)
```

**Critical Path:** Phase 0 → Phase 0.5 must complete before architectural decisions (TypeScript vs Rust)

---

## Phase 0 — Evidence Capture

**Objective:** Capture confirmed transactions and state for validation baseline + measure opportunity windows

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 0.1 | Transaction capture script | RPC polling for target venue swaps with slot/signature | G0.1, G0.3 |
| 0.2 | State snapshot service | Captures pool+vault+tick/bin state at tx slot | G0.2 |
| 0.3 | Evidence storage | JSON files: `tx_samples_{venue}.json`, `state_snapshots_{venue}.json` | G0.1, G0.2 |
| 0.4 | Validation dataset | Matched tx→state→result tuples | G0.2 |
| 0.5 | Opportunity window tracker | For each swap, measure state stability window (when did arb open/close) | G0.3 |
| 0.6 | Window distribution analyzer | Histogram of opportunity durations | G0.3 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G0.1 | Sample coverage | ≥1000 confirmed txs per venue | File count in evidence JSON |
| G0.2 | State completeness | 100% have slot-matched state | All samples have pool+vault+deps |
| G0.3 | Opportunity window measurement | ≥500 samples per venue | Distribution documented: p50, p90, p99 window duration |

### Evidence Required

```json
{
  "phase": 0,
  "timestamp": "ISO8601",
  "gates": {
    "G0.1": { 
      "target": "≥1000 per venue", 
      "actual": { "pumpswap": X, "raydiumV4": X, "raydiumClmm": X, "meteoraDlmm": X },
      "pass": true|false 
    },
    "G0.2": { 
      "target": "100%", 
      "actual": "X/Y samples with complete state", 
      "pass": true|false 
    },
    "G0.3": {
      "target": "≥500 per venue",
      "actual": {
        "pumpswap": { "n": X, "p50_ms": X, "p90_ms": X, "p99_ms": X },
        "raydiumV4": { "n": X, "p50_ms": X, "p90_ms": X, "p99_ms": X },
        "raydiumClmm": { "n": X, "p50_ms": X, "p90_ms": X, "p99_ms": X },
        "meteoraDlmm": { "n": X, "p50_ms": X, "p90_ms": X, "p99_ms": X }
      },
      "pass": true|false
    }
  },
  "overall": "PASS|FAIL",
  "recommendation": "TypeScript viable|Optimization needed|Rust required"
}
```

### Decision Point

After Phase 0 completion:
- **If p90 opportunity window > 10ms:** TypeScript likely viable, proceed to Phase 0.5 measurement
- **If p90 opportunity window < 5ms:** Rust probably required, but measure in Phase 0.5 to confirm
- **If p90 opportunity window 5-10ms:** Proceed to Phase 0.5, decision depends on TypeScript performance

---

## Phase 0.5 — Latency Baseline Measurement

**Objective:** Measure current implementation to determine if Rust rewrite is necessary

**Critical:** This phase measures what you HAVE, not what you need. Don't optimize yet.

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 0.5.1 | Instrumentation harness | Add t0-t4 timestamps to existing code | G0.5.1, G0.5.2 |
| 0.5.2 | Replay infrastructure | Feed Phase 0 evidence through current pipeline | G0.5.1 |
| 0.5.3 | Latency collector | Histogram collection per timing boundary | G0.5.1 |
| 0.5.4 | Profiler integration | Node.js profiler or perf for bottleneck identification | G0.5.2 |
| 0.5.5 | Memory baseline | Heap usage during representative load | G0.5.3 |

### Timing Boundaries (Same as Phase 7)

```
t0: Transaction received (simulated UDP recv or RPC response)
t1: Tx decoded (accounts resolved, swap params extracted)
t2: Sim complete (final output amount calculated)
t3: Decision rendered (profit calculated, threshold checked)
t4: Bundle bytes ready (serialized Jito bundle)
```

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G0.5.1 | Measurement complete | 10k samples | Histogram with p50/p90/p99/p99.9 for each boundary |
| G0.5.2 | Bottleneck identified | Top 3 operations documented | Profile flame graph + analysis |
| G0.5.3 | Memory footprint | Documented | Heap snapshot at steady state |

### Evidence Required

```json
{
  "phase": 0.5,
  "timestamp": "ISO8601",
  "gates": {
    "G0.5.1": {
      "target": "10k samples",
      "actual": {
        "samples": X,
        "t1_t0_decode_us": { "p50": X, "p90": X, "p99": X, "p99.9": X },
        "t2_t1_sim_us": { "p50": X, "p90": X, "p99": X, "p99.9": X },
        "t3_t2_decision_us": { "p50": X, "p90": X, "p99": X, "p99.9": X },
        "t4_t3_bundle_us": { "p50": X, "p90": X, "p99": X, "p99.9": X },
        "t4_t0_total_us": { "p50": X, "p90": X, "p99": X, "p99.9": X }
      },
      "pass": true|false
    },
    "G0.5.2": {
      "target": "documented",
      "actual": {
        "bottleneck_1": { "operation": "X", "pct_time": "XX%" },
        "bottleneck_2": { "operation": "X", "pct_time": "XX%" },
        "bottleneck_3": { "operation": "X", "pct_time": "XX%" }
      },
      "pass": true|false
    },
    "G0.5.3": {
      "target": "documented",
      "actual": "X.XX MB heap, Y.YY MB RSS",
      "pass": true|false
    }
  },
  "overall": "PASS|FAIL",
  "recommendation": "Ship TypeScript|Optimize TypeScript|Rust rewrite required"
}
```

### Decision Matrix

| Phase 0 Window (p90) | Phase 0.5 Latency (p99) | Decision |
|---------------------|------------------------|----------|
| > 10ms | < 5ms | **Ship TypeScript** - latency budget available |
| > 10ms | 5-10ms | **Optimize TypeScript** - identify hot path improvements |
| > 10ms | > 10ms | **Optimize TypeScript** - measure again, consider selective Rust modules |
| 5-10ms | < 5ms | **Ship TypeScript** - marginal latency budget |
| 5-10ms | 5-10ms | **Optimize TypeScript first** - Rust migration planned |
| 5-10ms | > 10ms | **Rust rewrite required** - TypeScript cannot meet window |
| < 5ms | < 3ms | **Ship TypeScript** - very tight but possible |
| < 5ms | 3-5ms | **Rust migration required** - insufficient margin |
| < 5ms | > 5ms | **Rust rewrite required immediately** - cannot compete |

### Architectural Decision

After Phase 0.5 evidence is captured, update WBS with:
- **Path A (TypeScript viable):** Proceed with Phases 1-8 as written, adjust latency targets to measured baseline + 20% optimization
- **Path B (Optimization needed):** Proceed with Phases 1-8, flag hot path modules for Rust rewrite post-Phase 8
- **Path C (Rust required):** Pause WBS, rewrite Phases 2-5 core modules in Rust, resume with hybrid architecture

**STOP POINT:** Do not proceed to Phase 1 until architectural decision is documented in WBS and STATE.json.

---

## Phase 1 — Confirmed State Ingest

**Objective:** Real-time confirmed state via Yellowstone gRPC (port 10000)

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 1.1 | gRPC consumer | Subscribes to account updates for target programs | G1.1, G1.2 |
| 1.2 | Program filter | Filters to 4 target venue program IDs | G1.1 |
| 1.3 | Ordering enforcement | slot/writeVersion ordering maintained | G1.3 |
| 1.4 | Backpressure handling | Sync handler, no dropped updates | G1.2 |
| 1.5 | Auto-reconnect | Recovers from disconnection | G1.4 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G1.1 | Per-update processing latency | p99 < 100μs | Histogram over 10k updates |
| G1.2 | Backpressure drops | 0 | Counter check |
| G1.3 | Ordering violations | 0 | Sequence validation |
| G1.4 | Replay consistency | 100% | Deterministic replay test |

### Evidence Required

```json
{
  "phase": 1,
  "timestamp": "ISO8601",
  "gates": {
    "G1.1": { "target": "p99 < 100μs", "actual": "XXμs", "pass": true|false },
    "G1.2": { "target": 0, "actual": X, "pass": true|false },
    "G1.3": { "target": 0, "actual": X, "pass": true|false },
    "G1.4": { "target": "100%", "actual": "XX%", "pass": true|false }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 1.5 — State Recovery & Monitoring

**Objective:** Detect and recover from cache desynchronization

**Rationale:** Missed gRPC messages, network hiccups, or service restarts can desync cache from cluster state. Without detection and recovery, all simulations become unreliable.

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 1.5.1 | Heartbeat monitor | Tracks last update timestamp per program (4 programs) | G1.5.1 |
| 1.5.2 | Slot lag detector | Compares cache highest slot to RPC getSlot() | G1.5.1 |
| 1.5.3 | Desync trigger conditions | Heartbeat timeout (5s) OR slot lag > 10 slots | G1.5.1 |
| 1.5.4 | Resync orchestrator | On trigger: pause simulation, clear cache, bootstrap, resume | G1.5.2 |
| 1.5.5 | Bootstrap service | RPC getProgramAccounts for all 4 programs | G1.5.2 |
| 1.5.6 | Health status flag | Boolean: cache_synced (gates simulation path) | G1.5.3 |
| 1.5.7 | Resync metrics | Counter: resync_events, histogram: resync_duration | G1.5.3 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G1.5.1 | Desync detection time | < 5 seconds | Simulated disconnect: kill gRPC, measure detection |
| G1.5.2 | Resync completion time | < 30 seconds for 1000 pools | Timed RPC fetch + decode + cache load |
| G1.5.3 | False positive rate | 0% over 24hr | Monitor production, verify no spurious resyncs |

### Evidence Required

```json
{
  "phase": 1.5,
  "timestamp": "ISO8601",
  "gates": {
    "G1.5.1": { 
      "target": "< 5s", 
      "actual": "X.XXs", 
      "test": "gRPC disconnect simulation",
      "pass": true|false 
    },
    "G1.5.2": { 
      "target": "< 30s for 1000 pools", 
      "actual": "X.XXs for Y pools", 
      "pass": true|false 
    },
    "G1.5.3": { 
      "target": "0%", 
      "actual": "X false positives in 24hr",
      "pass": true|false 
    }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 2 — Pool State Cache

**Objective:** Decode and cache pool state for all 4 venues

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 2.1 | PumpSwap decoder | Buffer → PumpSwapPool struct | G2.1 |
| 2.2 | Raydium V4 decoder | Buffer → RaydiumV4Pool struct | G2.1 |
| 2.3 | Raydium CLMM decoder | Buffer → RaydiumClmmPool struct | G2.1 |
| 2.4 | Meteora DLMM decoder | Buffer → MeteoraDlmmPool struct | G2.1 |
| 2.5 | PoolCache | Map<Pubkey, PoolState> with slot/writeVersion | G2.2 |
| 2.6 | Phase 1→2 handler | Routes gRPC updates to decoders and cache | G2.1, G2.2 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G2.1 | Decode success rate | ≥99.5% | Counter ratio over 10k accounts |
| G2.2 | Cache vs RPC match | 100% | 100 random samples compared to RPC |
| G2.3 | Memory footprint | Documented | Measurement in evidence |

### Evidence Required

```json
{
  "phase": 2,
  "timestamp": "ISO8601",
  "gates": {
    "G2.1": { "target": "≥99.5%", "actual": "XX.X%", "pass": true|false },
    "G2.2": { "target": "100%", "actual": "X/100", "pass": true|false },
    "G2.3": { "target": "documented", "actual": "X.XX MB", "pass": true|false }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 3 — Simulation-Ready State

**Objective:** Complete state required for accurate local simulation

**Key Insight:** Pool accounts contain vault pubkeys, not reserves. Simulation requires:
1. Pool state (from Phase 2)
2. Vault balances (SPL Token accounts)
3. Tick arrays (CLMM) / Bin arrays (DLMM)
4. All state from consistent slot

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 3.1 | Vault cache | Map<Pubkey, VaultBalance> with slot/writeVersion | G3.1 |
| 3.2 | Vault subscription | SPL Token program subscription for tracked vaults | G3.1 |
| 3.3 | Tick array decoder | Buffer → TickArray for Raydium CLMM | G3.2 |
| 3.4 | Tick array cache | (poolId, startTickIndex) → TickArray | G3.2 |
| 3.5 | Bin array decoder | Buffer → BinArray for Meteora DLMM | G3.3 |
| 3.6 | Bin array cache | (lbPair, index) → BinArray | G3.3 |
| 3.7 | Dependency pre-fetch | On pool discovery: subscribe to current + adjacent tick/bin arrays | G3.4 |
| 3.8 | Boundary detector | On pool update: if tickCurrent/activeId crosses boundary → subscribe new array | G3.4 |
| 3.9 | SimulationSnapshot | Struct containing pool + vaults + deps with slot validation | G3.5 |
| 3.10 | Bootstrap service | RPC fetch for missing dependencies at startup | G3.4 |
| 3.11 | Boundary crossing buffer | Pre-subscribe to ±3 tick/bin arrays from current position | G3.4 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G3.1 | Vault coverage | 100% of decoded pools | All pools have both vault balances |
| G3.2 | Tick array decode rate | ≥99.5% | Counter ratio |
| G3.3 | Bin array decode rate | ≥99.5% | Counter ratio |
| G3.4 | Dependency coverage | ≥99% of simulations | Sim attempts with missing deps classified (include boundary-cross misses) |
| G3.5 | Slot consistency | 100% | all_deps.slot >= pool.slot for every sim |

### Evidence Required

```json
{
  "phase": 3,
  "timestamp": "ISO8601",
  "gates": {
    "G3.1": { "target": "100%", "actual": "X/Y pools", "pass": true|false },
    "G3.2": { "target": "≥99.5%", "actual": "XX.X%", "pass": true|false },
    "G3.3": { "target": "≥99.5%", "actual": "XX.X%", "pass": true|false },
    "G3.4": { 
      "target": "≥99%", 
      "actual": "XX.X%", 
      "breakdown": {
        "total_attempts": X,
        "fulfilled": X,
        "missing_vault": X,
        "missing_tick": X,
        "missing_bin": X,
        "boundary_cross_miss": X
      },
      "pass": true|false 
    },
    "G3.5": { "target": "100%", "actual": "XX.X%", "pass": true|false }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 4 — Pending Path Bootstrap

**Objective:** Enable pending transaction decode and speculative state

**Architecture:**
- Jito ShredStream gRPC (port 11000) provides pending transactions
- ALT cache resolves v0 transaction addresses
- Speculative state layer applies pending tx deltas to confirmed state

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 4.1 | ALT cache | Map<Pubkey, AddressList> with slot versioning | G4.1 |
| 4.2 | ALT prefetch | Top N ALTs by historical usage loaded at startup | G4.1 |
| 4.3 | ALT miss handler | Async fetch + cache, non-blocking | G4.1 |
| 4.4 | ShredStream consumer | gRPC subscription to Jito ShredStream (port 11000) | G4.2 |
| 4.5 | v0 decoder | Resolves accountKeys via ALT cache | G4.2, G4.3 |
| 4.6 | Speculative state layer | Applies pending tx deltas to confirmed state | G4.4 |
| 4.7 | Pending tx queue | Ordered by slot, signature; expires on confirmation | G4.4 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G4.1 | ALT hit rate | ≥99.9% | Counter ratio over 10k v0 txs |
| G4.2 | Shred recv → tx decoded | p99 < 500μs | Histogram |
| G4.3 | Decoded key accuracy | 100% | 1000 sample txs validated against RPC |
| G4.4 | Speculative state accuracy | ≥99% | Compare speculative vs actual post-confirmation |

### Evidence Required

```json
{
  "phase": 4,
  "timestamp": "ISO8601",
  "gates": {
    "G4.1": { "target": "≥99.9%", "actual": "XX.XX%", "pass": true|false },
    "G4.2": { "target": "p99 < 500μs", "actual": "XXXμs", "pass": true|false },
    "G4.3": { "target": "100%", "actual": "X/1000", "pass": true|false },
    "G4.4": { "target": "≥99%", "actual": "XX.X%", "pass": true|false }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 5 — Swap Decode + Sequential Simulation

**Objective:** Accurate local simulation with multi-hop support

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 5.1 | PumpSwap swap decoder | Instruction → SwapParams | G5.1 |
| 5.2 | Raydium V4 swap decoder | Instruction → SwapParams | G5.1 |
| 5.3 | Raydium CLMM swap decoder | Instruction → SwapParams | G5.1 |
| 5.4 | Meteora DLMM swap decoder | Instruction → SwapParams | G5.1 |
| 5.5 | Multi-instruction parser | Ordered swap legs from transaction | G5.1 |
| 5.6 | constantProduct math | getAmountOut, getAmountIn (PumpSwap, V4) | G5.2 |
| 5.7 | CLMM math | sqrtPriceX64 math, tick traversal, liquidity delta | G5.3, G5.5 |
| 5.8 | DLMM math | Bin price calc, composition fee, bin traversal | G5.4, G5.6 |
| 5.9 | Fee calculator | Per-venue fee calculation (including variable fees) | G5.2, G5.3, G5.4 |
| 5.10 | Sequential simulator | Applies deltas to state in instruction order | G5.2, G5.3, G5.4 |
| 5.11 | Delta accumulator | Cumulative token flow across legs | G5.7 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G5.1 | Decode coverage | ≥99% of swap txs | Counter ratio |
| G5.2 | Single-hop accuracy (constant product) | ≤0.01% error | 1000 confirmed txs from Phase 0 evidence |
| G5.3 | Single-hop accuracy (CLMM) | ≤0.1% error | 1000 confirmed txs from Phase 0 evidence |
| G5.4 | Single-hop accuracy (DLMM) | ≤0.1% error | 1000 confirmed txs from Phase 0 evidence |
| G5.5 | Tick traversal accuracy | 100% | CLMM sims crossing ticks validated |
| G5.6 | Bin traversal accuracy | 100% | DLMM sims crossing bins validated |
| G5.7 | Multi-hop accuracy | ≤0.1% error | 500 confirmed multi-hop txs from Phase 0 evidence |

### Evidence Required

```json
{
  "phase": 5,
  "timestamp": "ISO8601",
  "gates": {
    "G5.1": { "target": "≥99%", "actual": "XX.X%", "pass": true|false },
    "G5.2": { "target": "≤0.01%", "actual": "X.XXX%", "pass": true|false },
    "G5.3": { "target": "≤0.1%", "actual": "X.XXX%", "pass": true|false },
    "G5.4": { "target": "≤0.1%", "actual": "X.XXX%", "pass": true|false },
    "G5.5": { "target": "100%", "actual": "X/Y", "pass": true|false },
    "G5.6": { "target": "100%", "actual": "X/Y", "pass": true|false },
    "G5.7": { "target": "≤0.1%", "actual": "X.XXX%", "pass": true|false }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 6 — Error Taxonomy

**Objective:** Classify all failure modes

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 6.1 | PumpSwap error decoder | Error buffer → ErrorType | G6.1 |
| 6.2 | Raydium V4 error decoder | Error buffer → ErrorType | G6.1 |
| 6.3 | Raydium CLMM error decoder | Error buffer → ErrorType | G6.1 |
| 6.4 | Meteora DLMM error decoder | Error buffer → ErrorType | G6.1 |
| 6.5 | Error classification enum | Slippage, InsufficientLiquidity, StaleState, InvalidAccount, Unknown | G6.1 |
| 6.6 | Failure tagging | Every sim/execution failure classified | G6.1 |
| 6.7 | Unknown bucket | Raw hex logged for audit | G6.2 |

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G6.1 | Classification rate | ≥95% | Unknown bucket size |
| G6.2 | Unknown logging | 100% | All unknowns have full context |

### Evidence Required

```json
{
  "phase": 6,
  "timestamp": "ISO8601",
  "gates": {
    "G6.1": { "target": "≥95%", "actual": "XX.X%", "pass": true|false },
    "G6.2": { "target": "100%", "actual": "X/Y", "pass": true|false }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 7 — Hot Path Latency Compliance

**Objective:** Meet latency targets on pending path (targets adjusted based on Phase 0.5 decision)

### Timing Boundaries

```
t0: Shred UDP recv (kernel timestamp)
t1: Tx decoded (accounts resolved)
t2: Sim complete
t3: Decision rendered
t4: Bundle bytes ready
```

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 7.0 | Baseline measurement reference | Phase 0.5 evidence (for comparison) | N/A |
| 7.1 | t0-t4 instrumentation | Timestamps at each boundary | All gates |
| 7.2 | Zero-allocation audit | No allocations t1→t3 for single-hop | G7.2 |
| 7.3 | Pre-allocated decode buffer | Decode scratch space | G7.1 |
| 7.4 | Pre-allocated sim workspace | Simulation state | G7.2 |
| 7.5 | Pre-allocated bundle buffer | Bundle construction | G7.4 |
| 7.6 | Latency histogram collector | Per-boundary timing collection | All gates |

### Gates

**Note:** Targets below are provisional and will be updated based on Phase 0.5 decision. If TypeScript is viable, targets may be relaxed. If Rust rewrite occurs, targets remain as-is.

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G7.1 | t1-t0 (decode) | p99 < 200μs | Histogram over 10k txs |
| G7.2 | t2-t1 (sim) | p99 < 500μs single, < 1.5ms multi | Histogram |
| G7.3 | t3-t2 (decision) | p99 < 50μs | Histogram |
| G7.4 | t4-t3 (bundle) | p99 < 200μs | Histogram |
| G7.5 | t4-t0 (total single-hop) | p99 < 1ms | Histogram |
| G7.6 | t4-t0 (total multi-hop) | p99 < 2ms | Histogram |

### Evidence Required

```json
{
  "phase": 7,
  "timestamp": "ISO8601",
  "baseline_reference": "data/evidence/phase0.5_gates.json",
  "gates": {
    "G7.1": { "target": "p99 < 200μs", "actual": "XXXμs", "baseline": "XXXμs", "improvement": "XX%", "pass": true|false },
    "G7.2": { "target": "p99 < 500μs", "actual": "XXXμs", "baseline": "XXXμs", "improvement": "XX%", "pass": true|false },
    "G7.3": { "target": "p99 < 50μs", "actual": "XXμs", "baseline": "XXμs", "improvement": "XX%", "pass": true|false },
    "G7.4": { "target": "p99 < 200μs", "actual": "XXXμs", "baseline": "XXXμs", "improvement": "XX%", "pass": true|false },
    "G7.5": { "target": "p99 < 1ms", "actual": "XXXμs", "baseline": "XXXμs", "improvement": "XX%", "pass": true|false },
    "G7.6": { "target": "p99 < 2ms", "actual": "X.Xms", "baseline": "X.Xms", "improvement": "XX%", "pass": true|false }
  },
  "overall": "PASS|FAIL"
}
```

---

## Phase 8 — Execution Path Integration

**Objective:** End-to-end bundle submission

**Note:** This phase submits bundles. It does NOT decide which opportunities to execute. Strategy filtering happens externally.

### Deliverables

| ID | Deliverable | Description | Required For Gates |
|----|-------------|-------------|-------------------|
| 8.1 | Opportunity interface | Typed struct with required fields (see below) | G8.3 |
| 8.2 | Bundle builder | Jito bundle from opportunity + payer + tip | G8.1 |
| 8.2b | Victim tx inclusion | Bundle builder supports including victim's pending tx (for sandwich/backrun) | G8.1 |
| 8.3 | Tip transaction | Random tip account selection from Jito list | G8.1 |
| 8.4 | Submission client | Jito RPC with retry and timeout | G8.1 |
| 8.5 | Receipt handler | Bundle ID → landing status tracking | G8.1 |

### Opportunity Interface (Required Fields)

```typescript
interface Opportunity {
  venue: VenueType;              // PumpSwap | RaydiumV4 | RaydiumClmm | MeteoraDlmm
  path: SwapLeg[];               // Ordered swap instructions
  amountIn: bigint;              // Input amount (lamports or token base units)
  amountOut: bigint;             // Simulated output amount
  profitSOL: number;             // Net profit in SOL (after fees and gas)
  gasEstimate: number;           // Estimated compute units
  timestamp: number;             // When opportunity was detected (ms)
  victimTx?: Transaction;        // Optional: victim tx for sandwich/backrun
}
```

**No optional fields except `victimTx`**. All opportunities reaching Phase 8 must have complete data.

### Gates

| Gate ID | KPI | Target | Validation Method |
|---------|-----|--------|-------------------|
| G8.1 | E2E flow | Complete | Pending swap → sim → opportunity → bundle submitted |
| G8.2 | Preflight pass rate | 100% | All test bundles pass Jito preflight |
| G8.3 | Type enforcement | Complete | TypeScript compilation enforces non-optional fields |

### Evidence Required

```json
{
  "phase": 8,
  "timestamp": "ISO8601",
  "gates": {
    "G8.1": { 
      "target": "complete", 
      "actual": "yes|no",
      "test_flow": "Injected pending tx → simulated → bundle built → submitted",
      "pass": true|false 
    },
    "G8.2": { 
      "target": "100%", 
      "actual": "X/Y bundles passed preflight", 
      "pass": true|false 
    },
    "G8.3": { 
      "target": "complete", 
      "actual": "Opportunity interface has no optional fields (except victimTx)",
      "pass": true|false 
    }
  },
  "overall": "PASS|FAIL"
}
```

---

## Validation Protocol

### Running Validation

Each phase has a validation script: `scripts/validate-phaseN.ts`

```bash
# Run validation for Phase N (requires live services)
pnpm exec tsx scripts/validate-phase5.ts

# Output goes to data/evidence/phase5_gates.json
```

### Validation Script Requirements

1. Tests against LIVE infrastructure (not mocks)
2. Outputs structured JSON to `data/evidence/phaseN_gates.json`
3. Returns exit code 0 only if ALL gates pass
4. Includes timestamp and raw measurements
5. Compares actual vs target for each gate

### Validation Scripts Are Measurement Instruments

Validation scripts exist to **measure** what the infrastructure can do. They do not exist to pass gates.

- **If a gate fails, fix the infrastructure** — the change goes in `src/`, not `scripts/`
- **Validation scripts are read-only observers** — they connect, measure, and report
- **Evidence must reflect actual infrastructure capability** — not test harness tricks

### Phase Completion Criteria

A phase is COMPLETE when:
1. All deliverables exist (verified by script)
2. Validation script runs successfully
3. Evidence JSON shows `"overall": "PASS"`
4. STATE.json updated with evidence reference

### Moving to Next Phase

Before starting Phase N+1:
1. Phase N evidence JSON exists
2. Evidence shows `"overall": "PASS"`
3. No blocking dependencies from earlier phases

---

## Critical Phase 0 + 0.5 Workflow

### Step 1: Phase 0 Evidence Capture

**Goal:** Capture 1000+ confirmed swaps per venue with opportunity window measurements

**Deliverables:**
- `data/evidence/tx_samples_pumpswap.json`
- `data/evidence/tx_samples_raydiumV4.json`
- `data/evidence/tx_samples_raydiumClmm.json`
- `data/evidence/tx_samples_meteoraDlmm.json`
- `data/evidence/opportunity_windows.json` (p50/p90/p99 window durations per venue)

**Validation:**
```bash
pnpm exec tsx scripts/validate-phase0.ts
# Outputs: data/evidence/phase0_gates.json
```

### Step 2: Phase 0.5 Baseline Measurement

**Goal:** Measure current TypeScript implementation performance

**Prerequisite:** Phase 0 evidence exists

**Process:**
1. Instrument existing code with t0-t4 timestamps
2. Replay Phase 0 evidence through pipeline
3. Collect latency histograms
4. Profile to identify bottlenecks

**Validation:**
```bash
pnpm exec tsx scripts/validate-phase0.5.ts
# Outputs: data/evidence/phase0.5_gates.json
```

### Step 3: Architectural Decision

**Input:** 
- Phase 0 opportunity windows (how long do arb windows stay open?)
- Phase 0.5 latency measurements (how fast is current implementation?)

**Output:**
- Document decision in `STATE.json` under `architectural_decision`
- Update Phase 7 latency targets if needed
- Flag modules for Rust rewrite if needed

**Decision logged as:**
```json
{
  "architectural_decision": {
    "timestamp": "ISO8601",
    "path": "TypeScript|TypeScript+Optimization|Rust Hybrid|Rust Rewrite",
    "rationale": "...",
    "phase7_targets_adjusted": true|false,
    "modules_flagged_for_rust": ["simulation", "bundle-builder"]
  }
}
```

### Step 4: Proceed to Phase 1

Only after architectural decision is documented and Phase 7 targets are finalized.

---

## Appendix: Rust Rewrite Triggers

If Phase 0.5 evidence shows Rust is required:

### Modules Most Likely to Require Rust

1. **Simulation engine** (Phase 5) - Most compute-intensive
2. **Bundle builder** (Phase 8) - Serialization and signing
3. **Tick/bin traversal** (Phase 5.7, 5.8) - Tight loops

### Modules That Can Stay TypeScript

1. **Cache management** (Phase 2, 3) - Map lookups are fine in JS
2. **gRPC consumers** (Phase 1, 4) - I/O bound, not compute bound
3. **Validation scripts** - Measurement tools, not hot path

### Hybrid Architecture Pattern

If selective Rust rewrite:
- TypeScript orchestration layer
- Rust for hot path modules via NAPI bindings
- Shared types via JSON schema
- Build complexity increases significantly

**Avoid hybrid unless Phase 0.5 proves it's required.**