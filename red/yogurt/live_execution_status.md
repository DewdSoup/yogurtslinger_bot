# Live Execution Status

Last updated: 2026-02-20 (UTC)

## 1) Executive Summary

This repository has a working Layer 3 execution framework for `cross_venue_ps_dlmm` (PumpSwap <-> Meteora DLMM) that can:
- ingest pending flow from ShredStream,
- detect candidate opportunities,
- simulate locally,
- build bundles,
- submit bundles to Jito,
- log full run telemetry to `data/live/run-*`.

Current bottleneck is **post-submit execution validity**:
- bundles are submitted,
- but rejected during simulation/validation by block engine,
- resulting in zero accepted/finalized/landed bundles and zero realized wallet PnL.

The current state is **execution-debug phase**, not profitable live phase yet.

## 2) Current Status (Latest Live Run)

Reference run: `data/live/run-1771630893426-877635`

Key metrics:
- `shredTxsReceived`: `780967`
- `swapsDetected`: `32441`
- `candidateEvaluations`: `1577`
- `routeEvaluations`: `2949`
- `opportunitiesFound`: `9`
- `bundlesBuilt`: `8`
- `bundlesSubmitted`: `8`
- `predictedProfitLamports`: `27410806` (~`0.027411 SOL`)
- `accepted`: `0`
- `rejected`: `8`
- `finalized/landed`: `0`
- `walletNetLamports`: `0`

Primary rejection pattern in this run:
- primary submit mode (`with victim tx`) fails with: `bundle contains an already processed transaction`
- fallback submit mode (`without victim tx`) submits successfully
- submitted fallback bundles are rejected with simulation failure at `Instruction 4`, custom errors `0xbbf`/`0xbc0`

Implication:
- discovery/build/submit transport path is alive,
- execution correctness under live conditions is still not passing.

## 3) Pipeline Overview (How It Works)

1. `scripts/run-backrun.ts` boots runtime.
2. `src/handler/phase3.ts` starts Layer 1 cache from gRPC (confirmed state).
3. `src/execute/backrun.ts` consumes:
   - cache events (for pair index upkeep),
   - shred events (pending transactions) for opportunity detection.
4. For candidate txs, backrun engine:
   - decodes swaps,
   - finds counterpart pools via `src/execute/pairIndex.ts`,
   - runs local route evaluation (`DLMM_TO_PS` and `PS_TO_DLMM`),
   - applies profit/sanity/risk gates.
5. If eligible:
   - build swap instructions and transaction bundle via `src/execute/bundle.ts`,
   - submit through `src/execute/submit.ts` (Jito client).
6. Runtime telemetry and artifacts are written to `data/live/run-<id>/...`.

## 4) Relevant Files and Their Roles

### Runtime entrypoint
- `scripts/run-backrun.ts`
  - Main operator entry.
  - Reads env config, validates keypaths, starts phase3, starts shred consumer, starts backrun engine.
  - Handles blockhash refresh strategy, ALT fetch mode, risk guards, periodic stats logging, graceful shutdown.
  - Writes run artifacts (`run-config.json`, `stats.jsonl`, `stats-latest.json`, final summary output).

### Core execution
- `src/execute/backrun.ts`
  - Strategy engine (`legacy_cpmm_same_pool` and `cross_venue_ps_dlmm`).
  - Maintains counters/latency/skip-reasons.
  - Evaluates route candidates using local simulation.
  - Applies canary/risk/profit/sanity/governor gates.
  - Handles submit fallback flows (`primary_with_victim`, fallback without victim, blockhash retry).
  - Writes ledger JSONL (including opportunities and submit events).

- `src/execute/pairIndex.ts`
  - O(1)-style counterpart lookup for cross-venue matching.
  - Tracks normalized WSOL pairs and pool membership across venues.

### Bundle construction and submit
- `src/execute/bundle.ts`
  - Builds per-venue swap instructions (PumpSwap, RaydiumV4, Meteora DLMM).
  - Builds tip/CU-configured v0 tx bundle payloads.
  - Supports DLMM metadata, bin-array PDA derivation, mint program overrides.

- `src/execute/submit.ts`
  - Jito client wrapper.
  - Submits bundle with retry.
  - Subscribes bundle result stream and emits states: `accepted`, `rejected`, `processed`, `finalized`, `dropped`.
  - Tracks aggregate submission/result stats.

### Layer 1 cache source-of-truth
- `src/handler/phase3.ts`
  - Maintains local cache from gRPC and controlled bootstrap RPC deps.
  - Owns pool/vault/tick/bin/config cache lifecycle and activation/freeze behavior.

### Evidence / proving / operations scripts
- `scripts/capture-evidence.ts`
  - Layer 2 capture pipeline (mainnet evidence into SQLite).

- `scripts/analyze-cross-venue.ts`
  - Post-capture overlap/opportunity structure analysis from evidence DB.

- `scripts/watch-cross-venue.ts`
  - Real-time overlap telemetry stream; writes rolling JSON output.

- `scripts/run-cross-venue-shadow.ts`
  - Shadow wrapper for backrun runner (dry-run defaults).

- `scripts/diagnose-shadow-cross-venue.ts`
  - Reads shadow output and summarizes skip reasons/top bottlenecks.

- `scripts/readiness-shadow-cross-venue.ts`
  - Gate-based readiness summary from shadow evidence.

- `scripts/prove-shadow-goal.ts`
  - Statistical projection against target daily SOL from shadow data.

- `scripts/prove-dlmm-l2.ts`
  - DLMM Layer 2 proving/coverage report.

## 5) Run Artifact Layout (Live)

Each live session writes to:
- `data/live/run-<timestamp>-<pid>/`

Files per run:
- `run-config.json`
  - exact configuration/endpoints/keys/risk params at run start.
- `stats.jsonl`
  - periodic structured snapshots over time.
- `stats-latest.json`
  - end-state summary for the run.
- `live-cross-venue-<runId>.jsonl`
  - detailed event ledger (`skip`, `opportunity`, `submit_result`).
- `live-cross-venue-opportunities-<runId>.jsonl`
  - only opportunity records (best for PnL candidate analysis).
- `live-cross-venue-latest.json`
  - rolling counters and summarized runtime metrics.
- `bundle-results.jsonl`
  - Jito result-stream outcomes per submitted bundle (`accepted/rejected/...`).

## 6) Conformance vs `LAYERS.md` and `MENTAL_MAP.md`

### Conforms (Yes)
- Layer separation is respected in code paths:
  - Layer 1 cache logic is in `phase3`/cache modules.
  - Layer 3 engine reads from cache and does not mutate Layer 1 state.
- Local simulation-first behavior is implemented in `backrun.ts` using local caches/snapshot path.
- Layer 2 tooling exists and remains separate from hot path.
- Execution telemetry is structured and persistent per run.

### Partial / Caveats
- `MENTAL_MAP.md` currently labels Layer 3 as "future/not started"; that text is outdated relative to current code.
- `LAYERS.md` emphasizes venue proof before execution; CPMM is proven, but DLMM execution path still has live rejection failures.
- Runtime includes non-hot-path RPC usage (wallet balance checks, ALT fallback fetches, blockhash source refresh), which is operationally practical but not pure "gRPC-only" infrastructure.

### Current conformance judgment
- Architectural conformance: **mostly conformant**.
- Layer readiness conformance for profitable live deployment: **not yet conformant** due to execution rejection bottleneck.

## 7) How to Run

### Shadow run (no live submission)
```bash
pnpm shadow:cross-venue
```

### Live run (direct)
Example template:
```bash
cd /home/dudesoup/code/yogurtslinger_bot/red/yogurt && \
DRY_RUN=0 \
STRATEGY_MODE=cross_venue_ps_dlmm \
INCLUDE_VICTIM_TX=1 \
KEYPAIR_PATH=/home/dudesoup/jito/keys/yogurtslinger-hot.json \
JITO_AUTH_KEYPAIR_PATH=/home/dudesoup/jito/keys/jito-bundles.json \
RPC_ENDPOINT=http://127.0.0.1:8899 \
BLOCKHASH_RPC_ENDPOINTS=https://api.mainnet-beta.solana.com \
BLOCKHASH_REFRESH_INTERVAL_MS=4000 \
BLOCKHASH_MIN_REFRESH_INTERVAL_MS=1200 \
BLOCKHASH_MAX_STALE_MS=12000 \
MAX_SUBMISSIONS_PER_SECOND=3 \
DUPLICATE_OPPORTUNITY_TTL_MS=3000 \
MAX_OPPORTUNITY_AGE_MS=1500 \
GRPC_ENDPOINT=127.0.0.1:10000 \
SHRED_ENDPOINT=127.0.0.1:11000 \
JITO_ENDPOINT=mainnet.block-engine.jito.wtf \
BACKRUN_SIZE_CANDIDATES_SOL=0.05,0.10,0.20,0.35 \
CANARY_MAX_INPUT_SOL=0.35 \
CANARY_MAX_SUBMISSIONS_PER_HOUR=120 \
MAX_WALLET_DRAWDOWN_SOL=0.30 \
pnpm tsx scripts/run-backrun.ts
```

## 8) How to Read Logs and Diagnose a Run

Set latest run helper:
```bash
RUN=$(ls -td data/live/run-* | head -1)
echo "$RUN"
```

### Quick status
```bash
jq '.' "$RUN/stats-latest.json"
jq '.counters,.skipReasons,.latencyUs,.pairIndex' "$RUN/live-cross-venue-latest.json"
```

### Submission/result health
```bash
jq -r '[.state,.reason] | @tsv' "$RUN/bundle-results.jsonl" | sort | uniq -c
jq -r 'select(.event=="submit_result") | [.ts,.submitMode,.submitOk,.submitError] | @tsv' "$RUN"/live-cross-venue-*.jsonl
```

### Opportunity quality
```bash
jq -r '[.ts,.route,.candidateInputLamports,.bestNetLamports,.buildSuccess] | @tsv' "$RUN"/live-cross-venue-opportunities-*.jsonl
```

### Skip reason concentration
```bash
jq '.skipReasons' "$RUN/live-cross-venue-latest.json"
```

## 9) How to Assess Recent Run Performance (Practical Scorecard)

Check in this order:

1. Detection throughput
- `swapsDetected`, `candidateEvaluations`, `routeEvaluations` rising steadily.

2. Conversion funnel
- `opportunitiesFound -> bundlesBuilt -> bundlesSubmitted -> accepted/finalized`.
- Target is non-zero accepted/finalized, not just submitted.

3. Rejection class
- Review `bundle-results.jsonl` reasons.
- If `simulationFailure` dominates, execution correctness is bottleneck.

4. PnL truth
- Predicted PnL: `predictedProfitLamports`.
- Realized PnL: `walletNetLamports` in `stats-latest.json`.
- Realized governs go/no-go, not predicted.

5. Cache and decode health
- `decode_fail` and `alt_miss` rates should remain controlled relative to throughput.
- `alt_rpc_ok` should trend upward in mixed ALT mode.

6. Latency
- Monitor `decodeP95`, `routeEvalP95`, `bundleBuildP95` in `live-cross-venue-latest.json`.

## 10) Current Blocking Issue (Operational)

Based on latest run evidence:
- Primary submit path with victim tx is frequently too late (`already processed`).
- Fallback submitted bundles are rejected at simulation (`Instruction 4` custom errors).
- Therefore, no accepted/finalized bundles and no realized wallet gain.

This is a correctness/execution acceptance issue, not a pure detection pipeline issue.

## 11) Notes on Status of Repository State

Current git working tree has local modifications in:
- `scripts/run-backrun.ts`
- `src/execute/backrun.ts`

These are active operational files for runtime behavior and diagnostics.

