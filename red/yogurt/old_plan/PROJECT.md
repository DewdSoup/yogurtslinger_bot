# Yogurt Pipeline — Project Specification

## Mission

Build a baseline MEV execution pipeline that proves a solo operator with private infrastructure can capture meaningful market share from institutional MEV extractors on Solana.

This is doctorate-level research with peer-reviewable accuracy requirements. The goal extends beyond personal profit to democratizing MEV and disrupting the industry stranglehold held by <10 major players.

## Objective

Baseline MEV execution pipeline with:
- Dual-path data architecture (confirmed state + pending transactions)
- 100% local simulation (no RPC simulation calls)
- Jito bundle execution with tip
- Foundation for strategy expansion and scaling

## Success Criteria

| Metric | Target |
|--------|--------|
| Single-hop latency (t0→t4) | p99 < 1ms |
| Multi-hop latency (t0→t4) | p99 < 2ms |
| Simulation accuracy vs on-chain | ≤0.1% error |
| Slot-consistent state | 100% of simulations |

## Infrastructure

### Compute Resources

| Component | Specification | Baseline Use | Post-Baseline Potential |
|-----------|---------------|--------------|------------------------|
| CPU | AMD Threadripper (48 cores / 24 threads) | ~4 cores | 20+ parallel strategy scanners |
| RAM | 512 GB | ~8-16 GB caches | Full order book state, ML models |
| Storage | 4x NVMe SSD | Capture/evidence | Historical data, ML training |
| GPU | NVIDIA RTX 5070 12GB (PCIe 5.0) | Unused | 1000s parallel sims, route finding, ML inference |
| NIC | Intel X540 10GbE | gRPC/ShredStream | Low-latency bundle submission |

### Hardware Utilization Targets

**Baseline (Phases 1-8):** Prove sub-1ms latency and ≤0.1% accuracy with minimal resources

**Post-Baseline Expansion:**
| Resource | Strategy Use Case |
|----------|-------------------|
| Idle 44 cores | Parallel venue scanning, opportunity detection |
| 500GB+ RAM | Full mempool state, cross-venue order books |
| GPU CUDA cores | Parallel route optimization (1000s paths/ms) |
| GPU memory | On-device pool state for zero-copy sim |
| PCIe 5.0 bandwidth | GPU ↔ CPU state sync at 64GB/s |

### Data Services

| Endpoint | Port | Purpose | Phase |
|----------|------|---------|-------|
| Yellowstone gRPC | 127.0.0.1:10000 | Confirmed state stream | 1-3 |
| Jito ShredStream gRPC | 127.0.0.1:11000 | Pending transactions | 4+ |
| Local Validator RPC | 127.0.0.1:8899 | Bootstrap, ALT resolution | All |
| Helius RPC | env: HELIUS_RPC_URL | Validation ground truth | Scripts only |
| Jito Bundle RPC | Whitelisted | Bundle submission | 8 |

### Development Tools

| Tool | Purpose | Location |
|------|---------|----------|
| Validation Script | Live measurement against confirmed txs | `scripts/validate-phase5.ts` |
| Evidence JSON | Gate pass/fail results | `data/evidence/phase5_gates.json` |
| Capture NDJSON | Full comparison data for analysis | `data/captured/phase5_validation.ndjson` |

## Target Venues (Baseline)

| Venue | Program ID | Pool Type |
|-------|------------|-----------|
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | Constant Product |
| Raydium V4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Constant Product |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Concentrated Liquidity |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Discrete Liquidity |

## Architecture: Extensibility by Design

The baseline is specifically designed to enable advanced strategy integration:

### Core Pipeline (Phases 1-8)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Yellowstone gRPC ──→ Account Decoder ──→ Pool Cache ──→ Snapshot Builder  │
│         ↓                                       ↓                           │
│  ShredStream gRPC ──→ Tx Decoder ──→ Pending Queue ──→ Speculative State   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SIMULATION LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  Swap Decode ──→ Sequential Sim ──→ Delta Accumulation ──→ Output Amount   │
│                                                                             │
│  Math Modules: constantProduct | clmm | dlmm | fees                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EXECUTION LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Opportunity ──→ Bundle Builder ──→ Jito Submission ──→ Landing Tracker    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Strategy Integration Points

Post-Phase 8, strategies plug into the pipeline at defined interfaces:

| Interface | Input | Output | Used By |
|-----------|-------|--------|---------|
| `PendingTxStream` | Raw pending txs | Decoded swaps | All strategies |
| `SimulationEngine` | SwapParams + State | Output amount | All strategies |
| `OpportunityEvaluator` | Sim results | Opportunity | Strategy-specific |
| `BundleBuilder` | Opportunity + victim tx | Signed bundle | Execution |

### Extensibility Guarantees

The baseline provides:

1. **State Consistency** — All simulations use slot-consistent snapshots
2. **Accurate Simulation** — ≤0.1% error vs on-chain execution
3. **Low Latency** — p99 < 2ms for full pipeline
4. **Pending Visibility** — ShredStream provides pending tx stream
5. **Bundle Ordering** — Jito bundles support victim tx inclusion
6. **Multi-Venue** — Unified interface across 4 venue types

## Directory Structure

```
/home/dudesoup/code/yogurtslinger_bot/red/yogurt/
├── .agent/                 # Governance files
│   ├── PROJECT.md          # This file
│   ├── WBS.md              # Work breakdown structure
│   ├── PROTOCOL.md         # Agent behavior rules
│   ├── STATE.json          # Current phase status
│   ├── GATE_REGISTRY.json  # Canonical gate definitions
│   ├── EVIDENCE_CONTRACT.md # Evidence schema
│   └── evidence/           # Validation output JSONs
├── src/
│   ├── ingest/             # Phase 1: gRPC consumers
│   ├── decode/             # Phase 2: Account decoders
│   ├── cache/              # Phase 2-3: State caches
│   ├── snapshot/           # Phase 3: Simulation snapshots
│   ├── pending/            # Phase 4: Pending path
│   ├── sim/                # Phase 5: Simulation engine
│   ├── error/              # Phase 6: Error taxonomy
│   ├── instrument/         # Phase 7: Latency instrumentation
│   ├── execute/            # Phase 8: Bundle execution
│   ├── handler/            # Phase orchestration
│   └── types.ts            # Shared type definitions
├── scripts/
│   └── validate-phase*.ts  # Gate validation scripts (integrated capture)
└── data/
    ├── programs.json       # Target program IDs
    ├── alt_hotlist.json    # Pre-cached ALTs
    └── captured/           # Capture files (phase5_validation.ndjson)
```

## MEV Strategies (Full Hierarchy)

Baseline pipeline is strategy-agnostic. Strategies plug in post-Phase 8.

### Tier S — Primary Revenue Targets

| Strategy | Mechanism | Baseline Requirement |
|----------|-----------|---------------------|
| **Sandwich Attacks** | Front-run → victim → back-run | ShredStream + bundle ordering (Phase 4, 8) |
| **Triggered Cross-Venue** | Pending tx distorts venue A → arb venue B | Multi-venue state + pending (Phase 3, 4, 5) |

### Tier A — Secondary Revenue

| Strategy | Mechanism | Baseline Requirement |
|----------|-----------|---------------------|
| **JIT Liquidity** | Add liquidity → earn fees → remove | CLMM/DLMM simulation (Phase 5) |
| **Liquidation Hunting** | Execute liquidations for bonus | Lending decoders (future) |
| **Token Launch** | First-mover in new pools | New pool detection (Phase 2) |

### Tier B — Opportunistic

| Strategy | Mechanism | Baseline Requirement |
|----------|-----------|---------------------|
| **Pure Cross-Venue Arb** | Buy low, sell high across venues | Multi-venue state (Phase 3) |
| **Multi-Hop Cyclic** | SOL → A → B → SOL profit | Route optimization (GPU, future) |
| **Statistical Arb** | ML prediction → position ahead | GPU inference (future) |

### Future Expansion

- Oracle arbitrage (add oracle decoders)
- NFT MEV (add NFT program decoders)
- MEV-on-MEV (bundle analysis)
- Lending integration (Solend, Marginfi, Kamino)

### Critical Notes

- Pure backrun on same pool = bagholding. Cross-venue exit OR sandwich structure required.
- Sandwich requires bundle with victim tx inclusion (Phase 8 deliverable 8.2b).
- GPU currently unused — enables parallel route finding, ML inference, 1000s of sims.
- 44+ cores currently idle — can run 20+ strategy scanners post-baseline.

## Competitive Advantage Strategy

### Why We Win

The MEV market on Solana is dominated by <10 institutional extractors with:
- Expensive co-location infrastructure
- Large engineering teams
- First-mover advantages

**Our competitive edge:**

| Advantage | Implementation | Competitors |
|-----------|----------------|-------------|
| **Complex venue math** | CLMM/DLMM with tick/bin traversal | Avoid due to failure risk |
| **Local simulation** | Zero RPC latency, 100% deterministic | RPC-dependent, variable latency |
| **Sub-1ms execution** | Optimized hot path, pre-allocation | Often 2-5ms+ |
| **Pending tx visibility** | ShredStream integration | Many lack pending path |
| **Accuracy confidence** | ≤0.1% proven error rate | Unknown/unverified |
| **Hardware headroom** | 44 idle cores, 12GB GPU, 500GB RAM | Maxed out infrastructure |

### What Others Avoid (Our Opportunity)

| Venue Type | Why Others Avoid | Our Approach |
|------------|------------------|--------------|
| CLMM pools | Tick traversal complexity, liquidity deltas | Full sqrtPriceX64 math, tick array caching |
| DLMM pools | Bin composition fees, discrete pricing | Accurate bin traversal, composition fee calc |
| Multi-hop routes | Compounding error, state consistency | Sequential simulation, delta accumulation |
| Variable fee pools | Fee rate lookup complexity | AmmConfig caching, per-pool fee rates |

### Failure Mode Exploitation

When competitors fail, we capture:
- Their failed simulation = our opportunity window
- Their slippage miscalculation = our profit margin
- Their stale state = our fresh snapshot advantage

**Target: Capture opportunities others cannot reliably execute.**

## Out of Scope (Baseline Phase)

- Strategy logic (selected post-Phase 8)
- Token classification
- RPC simulation (local only)
- Analytics in hot path
- Multi-bundle submission
- Connection pooling (evaluated post-baseline)

## Operator

- Doctorate candidate (AI/ML focus)
- MBA, Graduate Certificate in Data Analytics
- PMP, PMI-ACP certified
- DOE Q Clearance
- Technical Program Manager at Sandia National Labs (AI development team)
- 2+ years building MEV pipeline iterations
- Not a retail trader

## Governance

| Document | Purpose |
|----------|---------|
| `.agent/WBS.md` | Phase deliverables and gate definitions |
| `.agent/PROTOCOL.md` | Agent behavior rules (binding) |
| `.agent/GATE_REGISTRY.json` | Canonical gate IDs and thresholds |
| `.agent/EVIDENCE_CONTRACT.md` | Evidence schema and acceptance rules |
| `.agent/STATE.json` | Current phase status and next action |

See PROTOCOL.md for binding agent behavior rules.
