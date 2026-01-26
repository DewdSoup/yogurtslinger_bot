# Execution Infrastructure Analysis Report

**Source Repository:** `DewdSoup/mev` - `services/arb-mm/`
**Analysis Date:** 2026-01-21
**Purpose:** Extract execution patterns for yogurt MEV pipeline adoption

---

## Executive Summary

The arb-mm service implements a sophisticated execution pipeline with multi-layered risk gates, shadow mode capabilities, RPC simulation before send, and comprehensive session recording. Key architectural patterns include:

1. **Layered execution gates** (pre-EV, RPC sim, send gate)
2. **Shadow/sim-only mode** via `EXEC_MODE` and `USE_RPC_SIM` flags
3. **Dynamic tip pricing** based on RPC latency
4. **Comprehensive risk management** with kill switches and per-minute caps
5. **Session recording** for post-mortem analysis

---

## 1. Execution Flow Architecture

### 1.1 High-Level Flow

```
Decision (would_trade)
    │
    ▼
┌─────────────────────────┐
│  Pre-Send EV Gate       │  ← Rejects negative EV before any work
│  (buy_px, sell_px,      │
│   fixedCostPre)         │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Build Execution Legs   │  ← Phoenix + AMM instruction builders
│  (transaction_builder)  │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  RPC Simulation         │  ← simulateTransaction() with sigVerify
│  (rpcSimTx)             │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Post-Sim EV Gate       │  ← Re-check EV with actual CU used
│  (dynamic cost)         │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Send Gate              │  ← USE_RPC_SIM=1 blocks real sends
│  (canActuallySendNow)   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Submit Atomic TX       │  ← submitAtomic() with LUT support
│  (V0 message)           │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Confirm + Realize      │  ← confirmTransaction + balance delta
└─────────────────────────┘
```

### 1.2 Key Files & Responsibilities

| File | Responsibility |
|------|----------------|
| `executor/live.ts` | Main execution orchestrator (900+ lines) |
| `executor/transaction_builder.ts` | Builds ordered leg instructions |
| `executor/preflight.ts` | Pre-execution account checks |
| `tx/submit.ts` | Atomic TX submission with signer validation |
| `tx/rpcSim.ts` | RPC simulation wrapper |
| `tx/sendGate.ts` | Shadow mode + balance guard |
| `execute/maybeExecute.ts` | Alternative atomic executor |
| `submit/jito.ts` | Jito bundle submission (optional) |

---

## 2. Transaction Building Patterns

### 2.1 Execution Leg Abstraction

The system uses a unified `ExecutionLeg` type to represent both Phoenix and AMM swaps:

```typescript
type ExecutionLeg = PhoenixExecutionLeg | AmmExecutionLeg;

interface PhoenixExecutionLeg {
  kind: "phoenix";
  market: string;
  side: "buy" | "sell";
  sizeBase: number;
  limitPx: number;
  slippageBps?: number;
}

interface AmmExecutionLeg {
  kind: "amm";
  venue: "raydium" | "orca" | "meteora" | "lifinity";
  poolId: string;
  poolKind?: string;  // "clmm", "cpmm", etc.
  direction: "baseToQuote" | "quoteToBase";
  sizeBase: number;
  refPx: number;
  baseMint?: string;
  quoteMint?: string;
  label?: string;
}
```

### 2.2 Instruction Building Pipeline

```typescript
// From transaction_builder.ts
async function buildExecutionLegSequence(params: BuildLegSequenceParams): Promise<BuiltLegInstruction[]> {
  const built: BuiltLegInstruction[] = [];

  for (const leg of legs) {
    if (leg.kind === "phoenix") {
      const instructions = await buildPhoenixLeg(connection, payer, leg, phoenixSlippageBps);
      built.push({ kind: "phoenix", instructions, lookupTables: [], label: leg.side });
    } else {
      const { instructions, lookupTables } = await buildAmmLeg(...);
      built.push({ kind: "amm", instructions, lookupTables, label: leg.label });
    }
  }
  return built;
}
```

### 2.3 Per-Venue Builders

Each AMM venue has a dedicated builder:

| Venue | Builder | Key Features |
|-------|---------|--------------|
| Raydium CPMM | `buildRaydiumCpmmIx.ts` | Standard constant product |
| Raydium CLMM | `buildRaydiumClmmIx.ts` | Concentrated liquidity, LUTs |
| Orca Whirlpool | `buildOrcaWhirlpoolIx.ts` | Tick-based CLMM |
| Meteora DLMM | `buildMeteoraDlmmIx.ts` | Bin-based liquidity |
| Lifinity | `buildLifinityIx.ts` | Oracle-based AMM |

### 2.4 Compute Budget Handling

```typescript
// Pre-instructions always include CU budget
function buildPreIxs(units = 400_000, microLamports?: number): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units })
  ];
  if (typeof microLamports === 'number') {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  return ixs;
}

// Deduplication prevents double CU instructions
function dedupeComputeBudgetIxs(ixs: TransactionInstruction[]): TransactionInstruction[]
```

---

## 3. Risk Management Gates

### 3.1 Risk Module (`risk.ts`)

The risk module implements multiple independent guards:

```typescript
export function guardCheck(input: {
  pathId: string;
  notionalQuote: number;
  currentTps?: number;
}): { ok: true } | { ok: false; reason: string; value?: number; limit?: number }
```

#### Guard Types

| Guard | Env Variable | Purpose |
|-------|--------------|---------|
| Kill Switch | `GUARD_ERR_LATCH` | Latches on error burst, blocks all sends |
| Per-Minute Notional | `GUARD_PER_MIN_NOTIONAL_QUOTE` | Rate limit by $ volume |
| Consecutive Fails | `GUARD_CONSEC_FAILS_PATH` | Per-path failure circuit breaker |
| Error Burst | `GUARD_ERROR_BURST_MAX` | Window-based error rate limit |
| TPS Throttle | `GUARD_MIN_CHAIN_TPS` | Avoid sending during chain congestion |
| Master Disable | `GUARD_DISABLE=1` | Bypass all guards (dangerous) |

#### Kill Switch Behavior

```typescript
// Error burst triggers kill switch (optionally latched)
if (GUARD_ERR_MAX > 0 && errorTimestamps.length >= GUARD_ERR_MAX) {
  if (ERR_LATCH) {
    killSwitch = true;  // Stays on until manual reset
  }
}

// Auto-clear if not latched and quiet window passes
if (!ERR_LATCH && killSwitch && errorTimestamps.length < GUARD_ERR_MAX) {
  killSwitch = false;
}
```

### 3.2 Pre-Send EV Gate

Before any instruction building:

```typescript
// live.ts - Pre-send EV sanity check
const evQuotePre = (sell_px - buy_px) * sizeBase - fixedCostPre;
const evBps = ((sell_px / buy_px) - 1) * 10_000;

if (!FORCE) {
  if (!(evQuotePre > 0)) {
    logger.log("submit_error", { where: "pre_send_ev_gate", error: "negative_expected_pnl_quote" });
    return;
  }
  const wantBps = TRADE_THRESHOLD_BPS + PNL_SAFETY_BPS;
  if (evBps < wantBps) {
    logger.log("submit_error", { where: "pre_send_ev_gate", error: "insufficient_edge_bps" });
    return;
  }
}
```

### 3.3 Post-Simulation EV Gate

After RPC simulation reveals actual CU:

```typescript
// Compute final fixed cost using simulated units
const unitsUsed = sim.unitsConsumed ?? EST_UNITS_BEFORE_SIM;
const fixedCostFinal = estimateFixedCostQuote(unitsUsed, usedCuPrice, avgPx);

const evQuoteFinal = (sell_px - buy_px) * sizeBase - fixedCostFinal;
if (!FORCE && !(evQuoteFinal > 0)) {
  logger.log("submit_error", { where: "rpc_sim_ev_gate", error: "negative_expected_pnl_after_sim" });
  return;
}
```

### 3.4 Send Gate (`sendGate.ts`)

Final gate before actual broadcast:

```typescript
export async function canActuallySendNow(
  conn: Connection,
  opts: { env: NodeJS.ProcessEnv; owner: PublicKey; minLamports?: number }
): Promise<boolean> {
  // Sim-only mode wins
  if (USE_RPC_SIM === "1" || USE_RPC_SIM === "true") {
    return false;  // Never send real TXs
  }

  // Balance check
  const bal = await conn.getBalance(opts.owner, "confirmed");
  return bal >= minLamports;
}
```

---

## 4. Shadow Mode / Simulation Infrastructure

### 4.1 Execution Modes

```typescript
const EXEC_MODE = String(process.env.EXEC_MODE ?? "LIVE").trim().toUpperCase();
const SIM_ONLY = EXEC_MODE === "SIM_ONLY";
```

| Mode | `EXEC_MODE` | `USE_RPC_SIM` | Behavior |
|------|-------------|---------------|----------|
| Full Live | `LIVE` | `0` | Real trades |
| Shadow Mode | `LIVE` | `1` | Sim only, no sends |
| Sim-Only | `SIM_ONLY` | any | Log everything, no sends |

### 4.2 RPC Simulation

```typescript
// rpcSim.ts
export async function rpcSimTx(
  conn: Connection,
  tx: VersionedTransaction,
  opts?: { commitment?: "processed" | "confirmed"; sigVerify?: boolean }
): Promise<RpcTxSimResult> {
  const res = await conn.simulateTransaction(tx, { commitment, sigVerify });
  return {
    ok: !res.value?.err,
    err: res.value?.err,
    unitsConsumed: res.value?.unitsConsumed,
    logs: res.value?.logs,
    returnData: res.value?.returnData,
  };
}
```

### 4.3 Simulation Logging

```typescript
// Comprehensive sim event logging for ML/analysis
logger.log("tx_sim_start", { attempt_id, path, size_base, exec_mode });

if (sim.ok) {
  logger.log("tx_sim_ok", { units: sim.unitsConsumed, logs_tail: sim.logs?.slice(-6) });
} else {
  logger.log("tx_sim_err", { err: sim.err, logs_tail: sim.logs?.slice(-6) });
}

// In SIM_ONLY mode, log what would have happened
if (SIM_ONLY) {
  logger.log("tx_sim_dry_run_complete", {
    simulated_ev_quote: evQuoteFinal,
    fixed_cost_quote: fixedCostFinal,
    units_used: unitsUsed,
  });
  return;  // Don't proceed to send
}
```

---

## 5. Replay / Testing Infrastructure

### 5.1 Replay System (`replay.ts`)

Offline backtesting from JSONL logs:

```typescript
// replay.ts - Reconstructs market state from logs
async function main() {
  const ammsRaw = readJsonl(AMMS_JSONL);
  const phxRaw = readJsonl(PHOENIX_JSONL);

  // Convert to typed events, sort by timestamp
  const evs: Ev[] = [];
  for (const r of ammsRaw) { const e = toEv(r); if (e) evs.push(e); }
  for (const r of phxRaw) { const e = toEv(r); if (e) evs.push(e); }
  evs.sort((a, b) => a.ts - b.ts);

  // Replay with same decision logic as live
  for (const e of evs) {
    if (e.ts < from || e.ts > to) continue;
    // Update state, run decide(), emit features
  }
}
```

#### Replay Features

- **Time window filtering**: `--from ISO --to ISO`
- **Default: yesterday UTC**
- **Decision deduplication**: Coalesces noisy state changes
- **Feature emission**: Generates ML training data
- **Summary output**: JSON + Markdown reports

### 5.2 Session Recorder (`session_recorder.ts`)

Records live session metrics:

```typescript
export async function initSessionRecorder(conn: Connection, owner: PublicKey, cfg: AppConfig) {
  const start = {
    sol: await readSol(conn, owner),
    usdc: await readTokenUi(conn, usdcAta),
    wsol: await readTokenUi(conn, wsolAta),
  };

  async function finalize() {
    const end = { sol, usdc, wsol };  // Re-read balances
    const delta = { sol: end.sol - start.sol, ... };
    const stats = getSessionStats();  // from ml_logger

    // Write JSON + Markdown summary
    fs.writeFileSync(jsonFile, JSON.stringify({ session_id, balances, stats }));
  }

  process.once("SIGINT", finalize);
  process.once("SIGTERM", finalize);
}
```

#### Session Stats Tracked

- `considered`, `would_trade`, `would_not_trade`
- `submitted_tx`, `landed`, `land_error`
- `tip_lamports_sum`
- `best_edge_bps`, `worst_edge_bps`
- `filled_base_sum`, `filled_quote_sum`

### 5.3 Preflight Checks

```typescript
// preflight.ts - Pre-execution validation
export async function preflight(conn, cfg, owner): Promise<PreflightResult> {
  const checks = {
    low_sol_balance: lamports < cfg.MIN_SOL_BALANCE_LAMPORTS,
    missing_usdc_ata: !await accountExists(conn, usdcAta),
    missing_wsol_ata: !await accountExists(conn, wsolAta),
  };
  return { ok: !Object.values(checks).some(Boolean), checks, reasons };
}
```

---

## 6. Configuration Patterns

### 6.1 Environment Variable Hierarchy

```typescript
// config.ts - Multi-source config loading
const candidates = [
  ENV_FILE,                    // Explicit override
  path.resolve(SVC_ROOT, ".env.live"),  // Service-local live
  path.resolve(SVC_ROOT, ".env"),       // Service-local default
  path.resolve(REPO_ROOT, ".env.live"), // Repo root live
  path.resolve(REPO_ROOT, ".env"),      // Repo root default
];
```

### 6.2 Key Configuration Groups

#### Execution Controls

```bash
EXEC_MODE=LIVE              # LIVE | SIM_ONLY
USE_RPC_SIM=0               # 1 = shadow mode (sim only)
FORCE_EXECUTE_EVEN_IF_NEG=0 # 1 = bypass EV gates (dangerous)
FORCE_EXECUTE_MAX_BASE=0.1  # Clamp size when forcing
```

#### Tip/Fee Settings

```bash
TIP_MODE=cu_price                    # fixed | cu_price
TIP_MICROLAMPORTS_PER_CU=5000        # Base priority fee
TIP_MULTIPLIER=1.2                   # Latency-based multiplier
TIP_MAX_LAMPORTS=2000000             # Hard cap
SUBMIT_CU_LIMIT=400000               # CU budget
```

#### Risk Guards

```bash
GUARD_PER_MIN_NOTIONAL_QUOTE=50      # Max $/min
GUARD_CONSEC_FAILS_PATH=3            # Per-path circuit breaker
GUARD_ERROR_BURST_MAX=3              # Error window trigger
GUARD_ERROR_BURST_SECS=30            # Error window duration
GUARD_ERR_LATCH=0                    # 1 = kill switch stays on
GUARD_MIN_CHAIN_TPS=1000             # TPS throttle threshold
```

#### Decision Tuning

```bash
TRADE_THRESHOLD_BPS=10               # Min edge to trade
MAX_SLIPPAGE_BPS=2                   # Slippage tolerance
TRADE_SIZE_BASE=0.1                  # Default size
DECISION_MIN_BASE=0.001              # Min size guard
PNL_SAFETY_BPS=0                     # Extra edge buffer
```

### 6.3 Dynamic Parameters

```typescript
// Auto-apply params from daily optimization
if (AUTO_APPLY_PARAMS) {
  const { file, params } = loadLatestParamsSync(PARAMS_DIR);
  // Merge TRADE_THRESHOLD_BPS, MAX_SLIPPAGE_BPS, TRADE_SIZE_BASE
}
```

---

## 7. Jito Bundle Submission

### 7.1 Optional Jito Integration

```typescript
// jito.ts - Dynamic import for graceful degradation
export async function sendViaJito(
  txs: VersionedTransaction[],
  tipAccount: PublicKey
): Promise<JitoOk | JitoErr> {
  try {
    const maybe = await import("@jito-foundation/jito-ts").catch(() => null);
    if (!maybe) return { ok: false, error: "jito-ts module not installed" };

    const client = await SearcherClient.connect(url, keypair, "mainnet-beta");
    const bundle = new Bundle(txs, tipAccount);
    const { bundleId, signature } = await client.sendBundle(bundle);
    return { ok: true, bundleId, signature };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
```

### 7.2 Jito Configuration

```bash
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf
JITO_SEARCHER_KEYPAIR_JSON=[...]  # Searcher identity keypair
```

---

## 8. Recommendations for Yogurt Adoption

### 8.1 Immediate Adoptions (High Value)

1. **Send Gate Pattern**
   ```typescript
   // Implement in src/execute/submit.ts
   export async function canActuallySendNow(opts): Promise<boolean> {
     if (config.SHADOW_MODE) return false;
     return balance >= MIN_SOL_BALANCE;
   }
   ```

2. **Pre-Send EV Gate**
   ```typescript
   // Before building any instructions
   const evQuote = (sell - buy) * size - estimatedCost;
   if (evQuote <= 0 && !config.FORCE) {
     metrics.increment('submit_rejected_negative_ev');
     return;
   }
   ```

3. **RPC Simulation Before Send**
   ```typescript
   const sim = await connection.simulateTransaction(tx, { sigVerify: true });
   if (!sim.value || sim.value.err) {
     logger.log('sim_error', { err: sim.value?.err });
     return;
   }
   ```

4. **Dynamic Tip Pricing**
   ```typescript
   function computeAdaptiveCuPrice(): number {
     const p95 = getRpcLatencyP95();
     const bump = p95 > 1200 ? 6 : p95 > 800 ? 4 : p95 > 500 ? 2 : 1;
     return Math.min(BASE_CU_PRICE * bump, MAX_CU_PRICE);
   }
   ```

### 8.2 Risk Management (Critical)

1. **Kill Switch**
   ```typescript
   // Global kill switch for error bursts
   let killSwitch = false;
   const errorTimestamps: number[] = [];

   function noteError() {
     errorTimestamps.push(Date.now());
     const windowCount = errorTimestamps.filter(t => t > Date.now() - WINDOW_MS).length;
     if (windowCount >= ERROR_BURST_MAX) killSwitch = true;
   }
   ```

2. **Per-Minute Notional Cap**
   ```typescript
   let minuteNotional = 0;
   let windowStart = Date.now();

   function canTrade(notional: number): boolean {
     if (Date.now() - windowStart > 60_000) {
       windowStart = Date.now();
       minuteNotional = 0;
     }
     return minuteNotional + notional <= MAX_PER_MINUTE;
   }
   ```

### 8.3 Session Recording

```typescript
// At startup
const startBalances = await getBalances();

// On shutdown
process.on('SIGINT', async () => {
  const endBalances = await getBalances();
  const session = {
    started_at, stopped_at,
    balances: { start: startBalances, end: endBalances, delta: ... },
    stats: getSessionStats(),
  };
  await writeSessionReport(session);
});
```

### 8.4 Shadow Mode for S4 Development

```bash
# .env.shadow
EXEC_MODE=SIM_ONLY
USE_RPC_SIM=1
LOG_SIM_FIELDS=true
```

This allows full pipeline testing without risking real funds:
- All instructions built
- All simulations run
- All logs emitted
- No transactions broadcast

### 8.5 Execution Leg Abstraction

Adopt the unified leg type for multi-venue support:

```typescript
// src/execute/types.ts
export type ExecutionLeg = {
  kind: 'pumpswap' | 'raydiumV4' | 'raydiumClmm' | 'meteoraDlmm';
  poolId: string;
  direction: 'baseToQuote' | 'quoteToBase';
  sizeBase: number;
  refPx: number;
  baseMint?: string;
  quoteMint?: string;
};

// Build instructions generically
async function buildLeg(leg: ExecutionLeg): Promise<TransactionInstruction[]> {
  switch (leg.kind) {
    case 'pumpswap': return buildPumpSwapIx(leg);
    case 'raydiumV4': return buildRaydiumV4Ix(leg);
    // ...
  }
}
```

---

## 9. File Reference

### Core Execution
- `/services/arb-mm/src/executor/live.ts` - Main executor (900+ lines)
- `/services/arb-mm/src/executor/transaction_builder.ts` - Leg-based TX building
- `/services/arb-mm/src/execute/maybeExecute.ts` - Alternative atomic executor
- `/services/arb-mm/src/tx/submit.ts` - Atomic submission helpers
- `/services/arb-mm/src/tx/rpcSim.ts` - RPC simulation wrapper
- `/services/arb-mm/src/tx/sendGate.ts` - Shadow mode + balance gate

### Risk & Config
- `/services/arb-mm/src/risk.ts` - Risk management module
- `/services/arb-mm/src/config.ts` - Centralized configuration
- `/services/arb-mm/src/executor/preflight.ts` - Pre-execution checks

### Testing & Recording
- `/services/arb-mm/src/replay.ts` - Offline backtesting
- `/services/arb-mm/src/session_recorder.ts` - Live session metrics
- `/services/arb-mm/src/diag.ts` - Phoenix SDK diagnostics

### Jito Integration
- `/services/arb-mm/src/submit/jito.ts` - Optional bundle submission

---

## 10. Conclusion

The arb-mm execution infrastructure provides a robust template for yogurt's S4 (Jito Bundle Submission) and S6 (End-to-End Execution) sprints. Key takeaways:

1. **Defense in depth**: Multiple independent gates prevent bad trades
2. **Shadow mode first**: Full pipeline testing without real sends
3. **Observability**: Comprehensive logging at every decision point
4. **Graceful degradation**: Optional Jito, fallback to RPC
5. **Session accounting**: Track realized P&L per session

The leg-based abstraction and venue-specific builders align well with yogurt's multi-venue architecture (PumpSwap, RaydiumV4, RaydiumClmm, MeteoraDlmm).
