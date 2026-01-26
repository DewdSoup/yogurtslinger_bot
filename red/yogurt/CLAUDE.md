# CLAUDE.md

This file provides guidance to Claude Code agents working in this repository.

---

## CRITICAL: Read Before Working

**REQUIRED READING** (in order):
1. `MENTAL_MAP.md` — Architecture, data flow, strategic rationale
2. `LAYERS.md` — Layer definitions, progression rules, NO BANDAIDS rule
3. `CURRENT_STATE.json` — Current state, active work, next actions

**Do not skip these files.** Do not make assumptions. The current state is documented in `CURRENT_STATE.json` and must be read before starting any work.

---

## Core Principles

### 1. Local Cache State is Source of Truth

Layer 1 provides zero-latency mainnet state parity via gRPC (Yellowstone). This is the foundation for all downstream operations.

```
gRPC → Decoders → Caches → Math Engines
```

The cache is updated exclusively via confirmed account streams. Once a pool is frozen, RPC writes are rejected — only gRPC can mutate frozen pool state.

### 2. NO BANDAIDS

**This is non-negotiable.**

All fixes must be applied to Layer 1 infrastructure directly. Creating workarounds that make proving scripts pass without fixing Layer 1 is:
- A false positive
- Unacceptable
- Grounds for reverting the change

**Examples of unacceptable approaches:**
- Learning fees at runtime from observed swaps instead of fixing fee resolution in Layer 1
- Skipping transactions that fail instead of understanding why they fail
- Adding tolerances that mask real errors
- Using FeeOracle or similar workarounds that don't solve production problems

**HISTORICAL WARNING:** A previous FeeOracle workaround (`src/cache/feeOracle.ts`) inflated metrics to 99.87% passRate without fixing Layer 1. This was a FALSE POSITIVE. The true passRate without workarounds is UNKNOWN.

### 3. 100% Coverage Goal

Aim for 100% accuracy before moving to the next venue. Partial solutions are acceptable ONLY when the operator explicitly approves. "It's hard" is not a reason to move on.

### 4. Real Data is Ground Truth

On-chain transaction results are the only acceptable source of truth for proving infrastructure. Do not assume something works. Prove it with evidence.

### 5. Layer Progression

Do not skip layers. Each layer depends on the one below it.
- Layer 1 must be proven reliable via Layer 2 before Layer 3 development
- Layer 3 must be operational before Layer 4 feasibility check
- See `LAYERS.md` for complete layer definitions

---

## Build & Development Commands

```bash
pnpm install              # Install dependencies
pnpm typecheck            # Type check (no emit)
pnpm build                # Build to dist/

# Evidence capture (Layer 2 tool)
pnpm evidence 600         # Capture for 10 minutes (600s)
pnpm evidence 60          # Quick 1-minute capture
pnpm evidence             # Run indefinitely (Ctrl+C to stop)

# Infrastructure proving (Layer 2 tool)
npx tsx scripts/prove-infrastructure.ts    # Compare Layer 1 output to on-chain results
```

---

## Architecture Overview

See `MENTAL_MAP.md` for the complete data flow diagram.

### Layer 1: Local Cache State (Source of Truth)
```
src/
├── ingest/grpc.ts                    # Yellowstone gRPC confirmed stream
├── decode/programs/                   # Per-venue decoders
│   ├── pumpswap.ts                   # PumpSwap decoder
│   ├── raydiumV4.ts                  # RaydiumV4 decoder
│   ├── raydiumClmm.ts                # RaydiumClmm decoder
│   └── meteoraDlmm.ts                # MeteoraDlmm decoder
├── cache/                            # Typed caches
│   ├── commit.ts                     # Single entry point for cache mutations
│   ├── lifecycle.ts                  # State machine (DISCOVERED → FROZEN → ACTIVE)
│   ├── pool.ts, vault.ts, tick.ts, bin.ts  # Per-type caches
│   └── globalConfig.ts, ammConfig.ts # Config caches
└── sim/math/                         # Math engines
    ├── constantProduct.ts            # CPMM (PumpSwap, RaydiumV4)
    ├── clmm.ts                       # Concentrated liquidity (RaydiumClmm)
    └── dlmm.ts                       # Dynamic liquidity (MeteoraDlmm)
```

### Layer 2: Proving Tools (Identifies and Fixes Layer 1 Gaps)
```
scripts/
├── capture-evidence.ts               # Records mainnet data to SQLite
└── prove-infrastructure.ts           # Compares Layer 1 output to on-chain results

data/evidence/capture.db              # SQLite evidence database
```

### Layer 3: Execution Pipeline (Future - Not Started)
```
src/execute/                          # Stubs exist, not implemented
```

### Layer 4: Prediction Layer (Future - Requires Feasibility Check)
```
src/pending/                          # Some infrastructure exists, not proven
src/ingest/shred.ts                   # ShredStream consumer
```

---

## Supported Venues

| Venue | Program ID | Math Type | Layer 1 Status |
|-------|------------|-----------|----------------|
| PumpSwap | `pAMMBay...` | Constant Product | Has gaps (see CURRENT_STATE.json) |
| RaydiumV4 | `675kPX...` | Constant Product | Not yet proven |
| RaydiumClmm | `CAMMCz...` | Concentrated Liquidity | Not yet proven |
| MeteoraDlmm | `LBUZKh...` | Dynamic Liquidity | Not yet proven |

---

## Current Work

**Always check `CURRENT_STATE.json` for:**
- Active layer and current venue
- Known gaps and their status
- Next actions with priorities
- Invalid workarounds to avoid
- Pending decisions

The `CURRENT_STATE.json` file is the authoritative source for what needs to be done and what the current state is.

---

## Terminology

**DO USE:**
- Local cache state (not "simulation state")
- Proving (not "validating" or "simulating")
- Math engines (not "simulation engines")
- Execution pipeline (not "simulation pipeline")
- Layer 1 fix (for actual infrastructure changes)
- Gap (for issues found in Layer 1)

**DO NOT USE:**
- Simulation (ambiguous — avoid unless specifically about Layer 4)
- Phase (use "Layer" instead)
- Workaround (these are unacceptable)
- Bandaid (these are unacceptable)

---

## Evidence Database

**Database:** `data/evidence/capture.db`

| Table | Purpose |
|-------|---------|
| `mainnet_updates` | Raw gRPC account state |
| `cache_traces` | Cache mutations with source/rejected flags |
| `pending_shreds` | Pending TXs from ShredStream |
| `mainnet_txs` | Confirmed transactions |
| `topology_events` | Lifecycle state transitions |
| `frozen_topologies` | Dependency snapshots at freeze |
| `parsed_swaps` | Decoded swap legs for infrastructure proving |

---

## Lifecycle State Machine

```
(null) → DISCOVERED → TOPOLOGY_FROZEN → ACTIVE
              ↓              ↓
         RPC allowed    RPC blocked (gRPC only)
```

Once a pool is `TOPOLOGY_FROZEN`, RPC writes are **rejected**. Only gRPC updates can modify cache state.

---

## Environment Variables

```bash
GRPC_ENDPOINT=127.0.0.1:10000    # Yellowstone gRPC
SHRED_ENDPOINT=127.0.0.1:11000   # ShredStream
RPC_ENDPOINT=http://127.0.0.1:8899
DEBUG=1                          # Enable debug logging
```

---

## Agent Guidelines

### Before Starting Work
1. Read `MENTAL_MAP.md` to understand the architecture
2. Read `LAYERS.md` to understand what each layer does and the NO BANDAIDS rule
3. Read `CURRENT_STATE.json` to understand current state and priorities
4. Do not make assumptions about what is or is not working
5. Do not cite previous metrics — they may have been false positives

### During Work
1. Focus only on the current layer (see `activeLayer` in CURRENT_STATE.json)
2. Do not skip to future layers
3. **ALL FIXES MUST BE IN LAYER 1** — no workarounds
4. Do not accept partial solutions unless operator approves
5. Use `prove-infrastructure.ts` to verify changes
6. Update `CURRENT_STATE.json` if significant progress is made

### Before Ending Work
1. Update `CURRENT_STATE.json` with current state
2. Document any new issues discovered
3. Document any decisions made
4. Update `nextActions` if priorities changed
5. **Ensure no workarounds were introduced**

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `MENTAL_MAP.md` | Architecture, data flow, strategic rationale |
| `LAYERS.md` | Layer definitions, NO BANDAIDS rule, progression rules |
| `CURRENT_STATE.json` | Current state for agent handoff |
| `src/cache/commit.ts` | Single entry point for all cache mutations |
| `src/cache/lifecycle.ts` | Pool state machine + RPC containment |
| `src/sim/math/constantProduct.ts` | CPMM math (must match on-chain exactly) |
| `scripts/prove-infrastructure.ts` | Layer 2 proving tool |
| `scripts/capture-evidence.ts` | Layer 2 evidence capture |

---

## Hardware Context

This system runs on a home server (no colocation):
- AMD Threadripper 24 cores, 512GB RAM
- 3x NVMe SSD, 10Gb NIC
- Residential internet (not direct fiber)

**Implication:** Raw speed races are not viable. Competitive advantage comes from:
- Reliability (100% accurate state)
- Coverage (all venues simultaneously)
- Strategy selection (less contested opportunities)
- Computation-heavy strategies where local state matters

Target: >15 SOL/day initially via backrun opportunities, less contested pairs, complex multi-hop arbitrage.
