TopologyOracle Contract (Execution-Grade)
Purpose (non-negotiable)

The TopologyOracle exists to answer exactly one question:

“Which spatial accounts exist for this pool at a specific slot, and what are their initial bytes?”

It does not:
maintain live state
participate in execution decisions
reconcile differences
retry
poll
refresh

Once it finishes, it is dead forever for that pool.

Design Principles (lock these in)

RPC is topology-only

Topology is immutable

State truth comes only from gRPC

Missing account = provably empty

RPC data is always weaker than gRPC

No retries, no refresh, no healing

If any rule is violated, abort the pipeline.

Core Types
// topology/TopologyOracle.ts

export type TopologySource = "rpc-topology";

export type TopologyAccountKind =
  | "pool"
  | "vault"
  | "tick_array"
  | "bin_array"
  | "amm_config"
  | "global_config";

export interface TopologyAccountSnapshot {
  pubkey: Uint8Array;          // 32 bytes
  kind: TopologyAccountKind;

  exists: boolean;             // RPC existence result

  data?: Uint8Array;           // Present ONLY if exists === true
  dataLength?: number;         // Required if exists === true

  slot: number;                // Slot at which RPC was queried
  source: TopologySource;      // Always "rpc-topology"
}

Frozen Topology Snapshot

This is the only output of the oracle.
export interface FrozenTopology {
  pool: Uint8Array;

  slot: number;                // Single authoritative snapshot slot

  accounts: ReadonlyArray<TopologyAccountSnapshot>;

  topologyHash: Uint8Array;    // Deterministic hash over sorted accounts

  frozenAtUnixMs: number;
}

Hash definition (mandatory)
topologyHash = SHA256(
  concat(
    pool_pubkey,
    slot,
    for account in sort(accounts by pubkey):
      pubkey || kind || exists || dataLength || data?
  )
)

This hash becomes your proof anchor.

TopologyOracle Interface
export interface TopologyOracle {
  /**
   * Build a complete, frozen topology for a pool.
   *
   * This MUST be called exactly once per pool.
   * Any second call is a fatal error.
   */
  buildFrozenTopology(params: {
    pool: Uint8Array;
    poolKind: "CLMM" | "DLMM";

    // Derived deterministically from pool state
    tickSpacing?: number;
    binStep?: number;

    snapshotSlot: number;
  }): Promise<FrozenTopology>;
}

Deterministic Responsibilities
For CLMM
The oracle MUST:

Decode pool state (already available via gRPC)
Derive all possible tick array PDAs:
min tick → max tick
step = tickSpacing * TICK_ARRAY_SIZE
Issue one getMultipleAccounts RPC
Record:
exists = true + data if present
exists = false if null
Freeze topology

For DLMM

The oracle MUST:
Decode pool state
Derive all possible bin array PDAs
Same RPC rules as above
Freeze topology

No partial enumeration.
No radius heuristics.
No “current bin only” shortcuts.

Invariants (these are hard guarantees)

Invariant 1 — One-Shot Execution
if (oracleAlreadyRan(pool)) {
  throw new FatalError("TopologyOracle called twice for pool");
}

Invariant 2 — No State Mutation
TopologyOracle:
cannot import caches
cannot call set() on any cache
cannot emit events into handlers
It produces data only.

Invariant 3 — Weak Insertion Only
When topology data is injected into caches:
cache.set({
  pubkey,
  data,
  slot,
  writeVersion: -1,      // INVALID ON PURPOSE
  source: "rpc-topology",
  strength: "WEAK"
});

Rules:
Any gRPC update always overwrites
Any higher slot always overwrites
WEAK entries are never trusted for authority

Invariant 4 — Missing Account Semantics
If:
exists === false

Then:
Treat as zero liquidity
Treat as valid traversal endpoint
NEVER attempt RPC again
NEVER retry

This is not an assumption — it is a proof derived from PDA determinism.

Invariant 5 — No Execution Dependency

Simulation code MUST NOT:
call RPC
request topology
infer existence

Simulation only consumes:
FrozenTopology
Canonical gRPC state

If topology is missing → abort simulation
Failure Modes (and why they’re good)

| Failure                      | Behavior                      |
| ---------------------------- | ----------------------------- |
| RPC unavailable              | Pool never becomes active     |
| Incomplete topology          | Pool never becomes active     |
| gRPC overwrites topology     | Correct by definition         |
| Chain upgrade changes layout | TopologyHash mismatch → alert |


Why this solves your reliability paralysis

You no longer need to prove:
“local state matches mainnet”

You only need to prove:
“given this topologyHash + stateHash, simulation is correct”

That is finite, replayable, and deterministic.

What this enables next (important)

Once TopologyOracle exists, you can:
Archive FrozenTopology forever
Attach topologyHash to every simulation
Re-run historical swaps with exact topology
Prove CLMM/DLMM correctness without black-box tests
Stop second-guessing parity
This is the foundation layer you’ve been missing.