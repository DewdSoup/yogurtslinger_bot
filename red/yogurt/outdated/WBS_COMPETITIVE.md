# Yogurt Pipeline — Execution Gap Analysis

**Current State:** Local cache is reliable. Simulation math is implemented. gRPC ingest is working.

**Gap:** Cannot execute. No path from opportunity → landed transaction.

---

## What's Built

| Layer | Components | Status |
|-------|------------|--------|
| **Ingest** | gRPC consumer, ShredStream consumer | ✅ Working |
| **Decode** | Pool decoders (4 venues), swap decoder, vault decoder | ✅ Working |
| **Cache** | Pool, vault, tick, bin, ammConfig, lifecycle | ✅ Working (99.67% activation) |
| **Snapshot** | Slot-consistent state assembly | ✅ Working |
| **Speculative** | Pending TX delta layer | ✅ Designed |

### Simulation Layer Status

| Component | File | Status |
|-----------|------|--------|
| Simulation engine | `src/sim/engine.ts` | Exists, unvalidated |
| Constant product math | `src/sim/math/constantProduct.ts` | Exists, unvalidated |
| CLMM math (tick traversal) | `src/sim/math/clmm.ts` | Exists, unvalidated |
| DLMM math (bin traversal) | `src/sim/math/dlmm.ts` | Exists, unvalidated |
| Fee calculations | `src/sim/math/fees.ts` | Exists, unvalidated |
| Sequential multi-hop | `src/sim/sequential.ts` | Exists, unvalidated |

**What simulation code exists (not yet validated against on-chain):**
- `simulate(SimInput)` → `SimResult` for single swaps
- `simulateMultiHop(legs, poolStates, tickArrays, binArrays)` → `MultiSimResult`
- Tick traversal with liquidityNet deltas
- Bin traversal with dynamic fees
- Fee calculation per venue

**Validation needed:** Compare simulated output vs actual on-chain output to prove accuracy.

---

## What's Missing (Execution Layer — BLOCKING)

### 1. Swap Instruction Builders

**Current:** None. `src/execute/bundle.ts:buildSwapTransaction` is a stub that throws.

**Needed:** Per-venue instruction builders that produce `TransactionInstruction`.

| Venue | Accounts Required | Notes |
|-------|-------------------|-------|
| **PumpSwap** | pool, user, userBaseAta, userQuoteAta, baseVault, quoteVault, globalConfig, feeRecipient, systemProgram, tokenProgram | GlobalConfig already cached |
| **RaydiumV4** | amm, ammAuthority, ammOpenOrders, ammTargetOrders, poolCoinTokenAccount, poolPcTokenAccount, serumProgram, serumMarket, serumBids, serumAsks, serumEventQueue, serumCoinVaultAccount, serumPcVaultAccount, serumVaultSigner, userSourceTokenAccount, userDestTokenAccount, userOwner | Complex account set |
| **RaydiumClmm** | clmmProgram, payer, ammConfig, poolState, inputTokenAccount, outputTokenAccount, inputVault, outputVault, observationState, tokenProgram, tickArray0, tickArray1, tickArray2 | Tick arrays from cache |
| **MeteoraDlmm** | lbPair, binArrayBitmapExtension, reserveX, reserveY, userTokenX, userTokenY, tokenXMint, tokenYMint, oracle, hostFeeIn, user, tokenXProgram, tokenYProgram, eventAuthority, program | Bin arrays from cache |

**Files to create:**
```
src/execute/ix/pumpswap.ts
src/execute/ix/raydiumV4.ts
src/execute/ix/raydiumClmm.ts
src/execute/ix/meteoraDlmm.ts
```

---

### 2. Transaction Assembly

**Current:** None.

**Needed:**
- Versioned transaction (v0) construction
- Address Lookup Table resolution (ALT cache exists in `src/pending/altFetcher.ts`)
- Compute budget instructions (setComputeUnitLimit, setComputeUnitPrice)
- Blockhash fetching (or use durable nonce)

**File to create/complete:**
```
src/execute/transaction.ts
```

**Interface:**
```typescript
interface TransactionBuilder {
  build(
    instructions: TransactionInstruction[],
    payer: Keypair,
    recentBlockhash: string,
    computeUnits: number,
    priorityFee: bigint,
    lookupTables?: AddressLookupTableAccount[]
  ): VersionedTransaction;
}
```

---

### 3. Jito Bundle Construction

**Current:** `src/execute/bundle.ts` has structure but core functions throw.

**Needed:**
- `buildSwapTransaction()` — calls venue IX builder + transaction assembly
- `buildTipTransaction()` — SOL transfer to random Jito tip account
- Bundle assembly (swap TX + tip TX)

**Tip accounts already defined in bundle.ts:**
```typescript
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  // ... 6 more
];
```

---

### 4. Jito Bundle Submission

**Current:** `src/execute/submit.ts` has `JitoClient` class but methods throw.

**Needed:**
- `submitBundle()` — HTTP POST to Jito block engine
- `getBundleStatus()` — Poll for landing confirmation
- Retry logic (already stubbed)

**Jito Block Engine API:**
```
POST https://mainnet.block-engine.jito.wtf/api/v1/bundles
Body: { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[base64_tx1, base64_tx2]] }
```

---

### 5. Opportunity → Execution Coordinator

**Current:** No orchestration between detection and execution.

**Needed:** Something that:
1. Receives opportunity (from whatever strategy)
2. Fetches current pool state from cache
3. Calls appropriate IX builder
4. Assembles transaction
5. Builds bundle with tip
6. Submits to Jito
7. Tracks result

**Interface strategies will use:**
```typescript
interface Executor {
  execute(opportunity: Opportunity): Promise<ExecutionResult>;
}

interface Opportunity {
  venue: VenueId;
  pool: Uint8Array;
  direction: SwapDirection;
  inputAmount: bigint;
  expectedOutput: bigint;
  minOutput: bigint;
  // Strategy can add whatever else it needs
}

interface ExecutionResult {
  bundleId: string;
  submitted: boolean;
  landed?: boolean;
  slot?: number;
  profit?: bigint;
  error?: string;
}
```

---

## Priority

### Critical Path (Cannot Execute Without These)

```
IX Builders → Transaction Assembly → Bundle + Tip → Jito Submission
```

| Step | Component | Status | Blocks |
|------|-----------|--------|--------|
| 1 | Swap instruction builders (per venue) | Missing | Everything |
| 2 | Transaction assembly (v0 + signing) | Missing | Everything |
| 3 | Tip transaction construction | Stub | All bundles |
| 4 | Bundle assembly | Stub | All bundles |
| 5 | Jito HTTP submission | Stub | All execution |

### Not Blocking (Can Build In Parallel or After)

| Component | Reality |
|-----------|---------|
| Simulation accuracy validation | You'll learn if sim is wrong when TXs revert |
| Quoter wrapper | Convenience - simulation engine already works |
| Speculative state wiring | Strategy-specific (backrun/sandwich) |
| Reverse simulation | Strategy-specific |
| Route discovery | Strategy-specific |
| Execution coordinator | Nice abstraction, not required |

---

## File Structure

### Simulation Layer (exists + new)

```
src/sim/
├── engine.ts             # (exists) simulate(), simulateMultiHop()
├── sequential.ts         # (exists) Sequential multi-hop
├── math/
│   ├── constantProduct.ts # (exists) PumpSwap, RaydiumV4
│   ├── clmm.ts           # (exists) RaydiumClmm tick traversal
│   ├── dlmm.ts           # (exists) MeteoraDlmm bin traversal
│   └── fees.ts           # (exists) Fee calculations
├── quoter.ts             # (NEW) Quote generation for opportunities
├── router.ts             # (NEW) Route discovery
└── routeSimulator.ts     # (NEW) Multi-path simulation

scripts/
├── validate-simulation.ts # (NEW) Accuracy validation vs on-chain
```

### Execution Layer (stubs + new)

```
src/execute/
├── ix/
│   ├── pumpswap.ts       # (NEW) PumpSwap swap instruction
│   ├── raydiumV4.ts      # (NEW) RaydiumV4 swap instruction
│   ├── raydiumClmm.ts    # (NEW) RaydiumClmm swap instruction
│   └── meteoraDlmm.ts    # (NEW) MeteoraDlmm swap instruction
├── transaction.ts        # (NEW) Versioned TX assembly
├── bundle.ts             # (exists, stubs) Bundle construction
├── submit.ts             # (exists, stubs) Jito submission
├── executor.ts           # (NEW) Opportunity → execution coordinator
├── revenue.ts            # (exists) Revenue logging
└── types.ts              # (exists) Execution types
```

---

## What Strategies Will Plug Into

Once execution layer is complete, any strategy just needs to:

1. Detect an opportunity (however it wants)
2. Build an `Opportunity` object
3. Call `executor.execute(opportunity)`

The execution layer handles:
- Pool state lookup
- Instruction building
- Transaction assembly
- Bundle construction
- Jito submission
- Result tracking

Strategy code stays clean and focused on detection logic.
