# Yogurt Pipeline — Sprint Plan (ROI-Optimized + Speculative Pending Deltas)

**Project Goal:** Local cache state as sole source of truth for MEV/arbitrage execution on Solana.

**Current State:** Cache layer validated (99.67% activation, 1.45M gRPC updates accepted). Simulation math implemented. Ready for execution layer development.


**Note:** References to "Phase" in code comments or older docs are legacy terminology. This sprint plan is the authoritative roadmap for the **current architecture** (local cache as source of truth; no snapshot phase).

**End-to-End Latency Target:** Pending TX recv → bundle submitted: p99 < 50ms

---

## Sprint Overview

| Sprint | Goal | Demo Deliverable |
|--------|------|------------------|
| **S0** | Infrastructure & Prereqs | Test runner, types, keypair management |
| **S1** | Simulation Accuracy Validation (15 tasks) | Script proving sim output ±0.1% of on-chain + cross-repo validation |
| **S2** | Instruction Builders (Simple Venues) | PumpSwap, CLMM, DLMM IX builders with tests |
| **S2b** | RaydiumV4 + Serum Integration | RaydiumV4 IX builder with OpenBook accounts |
| **S3** | Transaction Assembly | V0 transactions with compute budget + signing |
| **S4** | Jito Bundle Submission | Bundles submitted to Jito block engine |
| **S4.5** | Speculative Pending Deltas Overlay | Order-aware post-pending reserve snapshots for CPMM |
| **S5** | Opportunity Detection | Backrun opportunities detected from pending TXs |
| **S6** | End-to-End Execution | Full pipeline: pending TX → opportunity → landed bundle |
| **S7** | Hardening & Observability | Error handling, circuit breaker, monitoring |

---

## Sprint 0: Infrastructure & Prerequisites

**Goal:** Establish test infrastructure and core types before implementation begins.

**Demo:** `pnpm test` runs with coverage report.

### Tasks

#### S0-T1: Test Infrastructure Setup
**Description:** Configure vitest/jest, coverage, and CI integration.

**Files:**
- `vitest.config.ts` (create)
- `package.json` (add test scripts)
- `.github/workflows/test.yml` (create if CI exists)

**Acceptance Criteria:**
- `pnpm test` runs and exits cleanly
- `pnpm test:coverage` generates coverage report
- Minimum 80% coverage threshold configured

**Validation:** `pnpm test` exits 0

---

#### S0-T2: Opportunity Type Definitions
**Description:** Define opportunity types early for stable interfaces.

**Files:**
- `src/opportunity/types.ts` (create)

**Acceptance Criteria:**
- `BackrunOpportunity`: triggerTx, targetPool, venue, direction, expectedProfit, optimalInput, minOutput
- `SandwichOpportunity`: front, back, expectedProfit (placeholder for future)
- `OpportunitySource`: pending_tx, block_arb, price_oracle
- `ProfitEstimate`: grossProfit, estimatedTip, netProfit, confidence

**Validation:** TypeScript compiles, types importable from other modules

---

#### S0-T3: Keypair Management
**Description:** Secure keypair loading and storage design.

**Files:**
- `src/wallet.ts` (create)
- `src/wallet.spec.ts` (create)

**Acceptance Criteria:**
- Load keypair from file path (env: `WALLET_PATH`)
- Support optional passphrase encryption
- Never log private key material (audit test)
- Clear keypair from memory on shutdown
- Validate keypair on load (can sign test message)

**Validation:** Unit tests pass, security audit checklist complete

---

#### S0-T4: Configuration System
**Description:** Runtime configuration with validation.

**Files:**
- `src/config.ts` (create)
- `src/config.spec.ts` (create)

**Acceptance Criteria:**
- Load from env vars with fallback defaults
- Parameters: `minProfitLamports`, `maxTipLamports`, `maxInputAmount`, `dryRun`, `circuitBreakerLossLimit`
- Validate on startup (type checking, range validation)
- Log sanitized config (no secrets)

**Validation:** Config loads with valid env, throws on invalid

---

#### S0-T5: Logging Infrastructure
**Description:** Structured logging with pino or similar.

**Files:**
- `src/logger.ts` (create)

**Acceptance Criteria:**
- Structured JSON logging (pino)
- Log levels: debug, info, warn, error
- Context propagation (txSignature, pool, venue)
- Async file sink for `data/logs/`

**Validation:** Logs written in valid JSON format

---


---

#### S0-T6: Hot-Path Data Contract Extensions (Pending Order + Raw TX + Instructions)
**Description:** Extend core hot-path types so speculative overlay and execution can operate without re-parsing or RPC.

**Files:**
- `src/types.ts` (update)
- `src/types.spec.ts` (create)

**Acceptance Criteria:**
- `TxUpdate` gains:
  - `rawTx?: Uint8Array` (full signed tx bytes when available from ShredStream)
  - `pendingOrder?: bigint` (monotonic order key for pending stream ordering)
- `DecodedTx` gains:
  - `instructions: CompiledInstruction[]` (compiled message instructions)
- `SwapLeg` gains:
  - `swapMode: SwapMode` where `SwapMode = { ExactIn: 0, ExactOut: 1 }`
- All new fields are optional where appropriate (confirmed path remains unchanged)
- TypeScript build succeeds (`pnpm typecheck`)

**Validation:**
- `pnpm typecheck` exits 0
- `src/types.spec.ts` compiles and asserts enum/value semantics (tsd-style smoke test)

---

#### S0-T7: DecodeTx Must Preserve Instructions
**Description:** Ensure Phase 4 decode produces `DecodedTx.instructions` so swap leg extraction and pending overlay can operate deterministically.

**Files:**
- `src/decode/tx.ts` (update)
- `src/decode/tx.spec.ts` (create)

**Acceptance Criteria:**
- `buildDecodedTx()` assigns `instructions` onto `DecodedTx`
- `DecodedTx.instructions.length` equals parsed instruction count for both legacy and v0 messages
- No additional allocations beyond existing instruction objects (reuse parsed slices where safe)
- Decode latency impact measured and recorded (micro-benchmark in test)

**Validation:**
- Unit test constructs a signed tx with `@solana/web3.js`, serializes, extracts `message`, runs `decodeTx()`, and asserts:
  - payer matches expected
  - instructions programIdIndex/accountKeyIndexes/data match compiled tx


---

#### S0-T8: Speculative Overlay Configuration Knobs
**Description:** Add explicit, testable configuration toggles for pending ordering and speculative overlay behavior (so you can ship safely in shadow mode).

**Files:**
- `src/config.ts` (update)
- `src/config.spec.ts` (update)

**Acceptance Criteria:**
- Add validated config fields (env + defaults):
  - `enableSpeculativeOverlay` (default: true)
  - `pendingExpirationSlots` (default: 10)
  - `pendingQueueMaxSize` (default: 10000)
  - `pendingMaxOpsPerPool` (default: 100)
- Config validation enforces sane ranges (non-negative, upper bounds)
- Sanitized config logging includes these flags

**Validation:** Unit tests cover defaults + invalid values (throws)

## Sprint 1: Simulation Accuracy Validation

**Goal:** Prove simulation math matches on-chain execution within ±0.1% tolerance.

**Demo:** Run `pnpm validate:sim` against confirmed swaps, report accuracy metrics.

**Prerequisite:** S0 complete

### Tasks

#### S1-T0: Evidence Database Schema Verification
**Description:** Verify evidence DB has required tables and schema.

**Files:**
- `scripts/verify-evidence-schema.ts` (create)

**Acceptance Criteria:**
- Check tables exist: `mainnet_txs`, `parsed_swaps`, `cache_traces`
- Verify column types match expected
- Report row counts per table
- Fail if schema mismatch

**Validation:** Schema verification passes against existing evidence DB

---

#### S1-T1: Swap Extraction Query
**Description:** Extract confirmed swap TXs with pre/post balances from evidence DB.

**Files:**
- `scripts/validate-simulation.ts` (create)

**Acceptance Criteria:**
- Query returns: signature, slot, venue, pool, direction, inputAmount, actualOutput
- Joins `mainnet_txs` + `parsed_swaps` tables
- Returns available swaps, minimum 50 per venue for validation to proceed
- Handles missing venues gracefully (skip with warning)

**Validation:** Query returns structured results for at least 3 venues

---

#### S1-T2: Snapshot Reconstruction from Evidence
**Description:** Reconstruct exact cache state at a swap's slot.

**Files:**
- `scripts/validate-simulation.ts` (extend)

**Acceptance Criteria:**
- Reconstruct pool state from `cache_traces` at swap's slot (latest writeVersion ≤ slot)
- Reconstruct tick/bin arrays from `cache_traces`
- Inject vault balances from `cache_traces` vault entries
- Validate: reconstructed slot within ±5 of swap slot (document tolerance)

**Validation:** Reconstructed state matches expected reserves for 10 manual samples

---

#### S1-T3: Single-Venue Accuracy Test (PumpSwap)
**Description:** Validate constant product sim for PumpSwap.

**Files:**
- `scripts/validate-simulation.ts` (extend)
- `src/sim/math/constantProduct.spec.ts` (create)

**Acceptance Criteria:**
- Compare simulated output vs actual output for ≥200 PumpSwap swaps
- Report: sample_count, mean_error_pct, max_error_pct, p50/p95/p99 error, pass_rate (within 0.1%)
- Pass rate ≥99%
- Flag systematic bias (mean error > 0.05% in either direction)

**Validation:** `pnpm validate:sim --venue=pumpswap` reports ≥99% pass rate

---

#### S1-T4: Single-Venue Accuracy Test (RaydiumV4)
**Description:** Validate constant product sim for RaydiumV4.

**Files:**
- `scripts/validate-simulation.ts` (extend)
- `src/sim/math/constantProduct.spec.ts` (extend)

**Acceptance Criteria:**
- Compare simulated output vs actual for ≥200 RaydiumV4 swaps
- Account for PnL adjustments (baseNeedTakePnl, quoteNeedTakePnl)
- Pass rate ≥99%

**Validation:** `pnpm validate:sim --venue=raydiumv4` reports ≥99% pass rate

---

#### S1-T5: Single-Venue Accuracy Test (RaydiumClmm)
**Description:** Validate CLMM tick traversal sim.

**Files:**
- `scripts/validate-simulation.ts` (extend)
- `src/sim/math/clmm.spec.ts` (create)

**Acceptance Criteria:**
- Compare simulated output vs actual for ≥200 RaydiumClmm swaps
- Include tick array reconstruction
- Report tick crossing accuracy (simulated crossings match actual)
- Pass rate ≥98% (lower due to tick complexity)

**Validation:** `pnpm validate:sim --venue=clmm` reports ≥98% pass rate

---

#### S1-T6: Single-Venue Accuracy Test (MeteoraDlmm)
**Description:** Validate DLMM bin traversal sim.

**Files:**
- `scripts/validate-simulation.ts` (extend)
- `src/sim/math/dlmm.spec.ts` (create)

**Acceptance Criteria:**
- Compare simulated output vs actual for ≥200 MeteoraDlmm swaps
- Include bin array reconstruction and dynamic fee
- Report bin crossing accuracy
- Pass rate ≥98%

**Validation:** `pnpm validate:sim --venue=dlmm` reports ≥98% pass rate

---

#### S1-T7: Multi-Hop Accuracy Test
**Description:** Validate sequential multi-hop simulation.

**Dependencies:** S1-T3, S1-T4, S1-T5, S1-T6 (all single-venue tests)

**Files:**
- `scripts/validate-simulation.ts` (extend)
- `src/sim/sequential.spec.ts` (create)

**Acceptance Criteria:**
- Find ≥30 multi-hop swaps in evidence (2+ legs)
- Compare final output to simulated
- Each leg must be within tolerance
- Overall pass rate ≥95%

**Validation:** `pnpm validate:sim --multihop` reports ≥95% pass rate

---

#### S1-T8: Accuracy Report Generator
**Description:** Generate comprehensive accuracy report.

**Files:**
- `scripts/validate-simulation.ts` (extend)
- `data/reports/simulation-accuracy.json` (output)

**Acceptance Criteria:**
- JSON report: venue, sample_count, mean_error_pct, max_error_pct, p50/p95/p99 error, pass_rate
- Summary section: overall pass rate, worst venue, systematic bias flags
- Human-readable markdown summary

**Validation:** Report file generated with all tested venues present

---

#### S1-T9: Cross-Repository Formula Verification (CPMM)
**Description:** Verify yogurt CPMM math matches implementations in yogurt_bot and red repositories.

**CRITICAL FINDING:** PumpSwap uses **direction-dependent** fee placement:
- **SELL (baseToQuote):** Fee applied to OUTPUT (post-swap)
- **BUY (quoteToBase):** Fee applied to INPUT (pre-swap)

Yogurt's current `constantProduct.ts` applies fee pre-swap for ALL directions, which is incorrect for PumpSwap SELL.

**Reference Files (read-only):**
- `../../../src/simulation/localSimulator.ts` (yogurt_bot root)
- `../src/sim/pumpswapSim.ts` (red) - See lines 93-130 for asymmetric fee pattern
- `../src/sim/raydiumV4Sim.ts` (red)

**Acceptance Criteria:**
- Document formula discrepancies between implementations:
  - Fee application order: SELL=post-output, BUY=pre-input
  - Rounding behavior (floor vs ceiling)
  - Fee rate encoding (bps vs basis points * 100)
- Create 10 SELL test vectors verifying fee-on-output behavior
- Create 10 BUY test vectors verifying fee-on-input behavior
- Document formulas:
  - SELL: `amountOut = grossOut - (grossOut * feeBps / 10000)`
  - BUY: `netIn = amountIn - (amountIn * feeBps / 10000)`
- **Decision Required:** Either modify yogurt's CPMM to support direction-dependent fee placement, OR create PumpSwap-specific simulator
- Verify yogurt output matches red `simulatePumpSwapSwap()` within 1 unit for both directions

**Validation:** Formula comparison document created, 20 test vectors pass (10 SELL, 10 BUY)

---

#### S1-T10: Cross-Repository Formula Verification (CLMM)
**Description:** Verify yogurt CLMM math matches implementations in red and DewdSoup/mev repositories.

**CRITICAL:** AmmConfig accounts are read-only and not streamed via gRPC. Fee rate comes from AmmConfig, not pool state.

**Reference Files (read-only):**
- `../src/sim/raydiumCLMMSim.ts` (red)
- `../src/decoders/raydiumTickArray.ts` (red)
- `../src/regression/runCanonicalRegression.ts` (red) - lines 571-584 for AmmConfig fetching
- DewdSoup/mev: `services/arb-mm/src/edge/clmm_quoter.ts` (via GitHub MCP)

**Acceptance Criteria:**
- Verify tick→sqrtPrice conversion matches on-chain (binary decomposition)
- Verify `getAmount0Delta` / `getAmount1Delta` formulas
- Verify tick crossing liquidity updates match red's `simulateRaydiumCLMMSwapExactIn()`
- **AmmConfig Resolution:** Implement fetcher that caches AmmConfig by pubkey
- **Verify:** tradeFeeRate extraction from AmmConfig (not pool state)
- **Document:** Configurable CLMM fee tiers: 1, 4, 25, 100 bps
- **Document:** Recommended tick array cache TTL (3s max per DewdSoup/mev pattern)
- Compare against DewdSoup/mev SDK-based approach (documents trade-offs)
- Include 5 fixtures that cross tick boundaries

**Validation:** 10 CLMM swap fixtures produce identical results (5 single-tick, 5 crossing boundaries)

---

#### S1-T11: Cross-Repository Formula Verification (DLMM)
**Description:** Verify yogurt DLMM math matches implementations in red repository.

**Reference Files (read-only):**
- `../src/sim/meteoraDLMMSim.ts` (red)
- `../src/decoders/meteoraBinArray.ts` (red)
- `../src/decoders/meteoraLbPair.ts` (red)
- `../src/regression/runCanonicalRegression.ts` (red) - lines 690-730 for bin array resolution

**Acceptance Criteria:**
- Verify bin price formula: `price = (1 + binStep/10000)^binId`
- **Bin Traversal Direction:**
  - swapForY (X→Y): decrements binId (moves toward lower bins)
  - !swapForY (Y→X): increments binId (moves toward higher bins)
- Verify dynamic fee calculation matches red's implementation
- **Bin Array Resolution:** Implement `deriveMeteoraBinArrayPda(lbPair, index)` matching red's pattern
- Verify `buildMeteoraBinLiquidityMap()` bin aggregation pattern
- Include fixtures that span multiple BinArray accounts
- Include 5 fixtures that deplete bins (force bin traversal)
- Compare against red's `simulateMeteoraDlmmSwap()` for 15 test fixtures

**Validation:** 15 DLMM fixtures produce identical bin crossing behavior (10 normal, 5 depletion)

---

#### S1-T12: Canonical Regression Harness Port
**Description:** Port red's canonical regression harness pattern to yogurt for ongoing validation.

**Reference File (read-only):**
- `../src/regression/runCanonicalRegression.ts` (red)

**Files:**
- `scripts/canonical-regression.ts` (create)
- `scripts/export-canonical.ts` (create) - Export from evidence DB
- `data/canonical/` (directory for NDJSON test cases)

**Test Case Sources:**
1. **Evidence DB Export:** `scripts/export-canonical.ts` extracts from `data/evidence/capture.db`
2. **Manual Fixtures:** Edge case fixtures created for specific scenarios

**Acceptance Criteria:**
- Implement `CanonicalSwapCase` type matching red's format
- Build `InMemoryAccountStore` from preAccounts
- Extract `tokenDelta()` from tokenBalances for actual vs simulated comparison
- Support all 4 venues: pumpswap, raydium_v4, raydium_clmm, meteora_dlmm
- Mismatch tolerance: ≤1 unit difference (atomic unit precision)
- Exit code 2 on any mismatch (CI-compatible)
- **Minimum Coverage:**
  - 25 cases per venue (100 total minimum)
  - 5 CLMM swaps crossing tick boundaries
  - 5 DLMM swaps depleting bins
  - 5 cases with near-zero output (<1000 atomic units)

**Validation:** `pnpm canonical:regression data/canonical/sample.ndjson` processes 100+ cases with 0 mismatches

---

#### S1-T13: Precision Upgrade Evaluation (Decimal.js)
**Description:** Evaluate whether high-precision Decimal.js math (per DewdSoup/mev) is needed for yogurt CPMM.

**Reference File (read-only, via GitHub MCP):**
- DewdSoup/mev: `services/arb-mm/src/util/cpmm.ts` (40-digit Decimal.js precision)

**Test Parameters:**
| Reserve Ratios | Input Amounts (atomic units) |
|----------------|------------------------------|
| 1:1 | 1, 10, 100, 1000 |
| 1:100 | 1, 10, 100, 1000 |
| 1:10,000 | 1, 10, 100, 1000 |
| 1:1,000,000 | 1, 10, 100, 1000 |

**Reserve Ranges:**
- Min: 1e6 (1 token with 6 decimals)
- Max: 1e18 (1 billion with 9 decimals)

**Acceptance Criteria:**
- Document current BigInt precision vs Decimal.js 40-digit precision
- Test 64 cases (4 ratios × 4 amounts × 4 reserve sizes)
- Calculate: `|BigInt_result - Decimal_result| / Decimal_result`
- **Precision Drift Threshold:** >0.001% difference is significant
- **Upgrade Recommendation:** If >1% of cases show significant drift
- Document which specific scenarios cause drift (likely: extreme ratios + small amounts)

**Validation:** Precision analysis report with data table and recommendation

---

#### S1-T14: Fee Structure Audit (Per-Venue)
**Description:** Audit and document exact fee structures for each venue based on red regression findings.

**Reference:**
- Red regression output: PumpSwap fee correlation analysis
- `../src/sim/pumpswapSim.ts` (red) - lines 93-130

**Files:**
- `docs/FEE_STRUCTURES.md` (create)

**Acceptance Criteria:**

**PumpSwap (CRITICAL - Asymmetric):**
- Total: 25 bps (LP 20 + Protocol 5 + coinCreatorFee typically 0)
- **SELL (baseToQuote):** Fee applied to OUTPUT (post-swap)
  ```typescript
  // grossOut = (quoteReserve * amountIn) / (baseReserve + amountIn)
  // amountOut = grossOut - (grossOut * 25 / 10000)
  ```
- **BUY (quoteToBase):** Fee applied to INPUT (pre-swap)
  ```typescript
  // netIn = amountIn - (amountIn * 25 / 10000)
  // amountOut = (baseReserve * netIn) / (quoteReserve + netIn)
  ```
- Rounding: floor for fee deduction

**RaydiumV4:**
- Pool-specific (swapFeeNumerator/swapFeeDenominator)
- Fee applied on input (pre-swap)
- OpenOrders adjustment required for reserves

**RaydiumClmm:**
- AmmConfig tradeFeeRate (bps)
- Configurable tiers: 1, 4, 25, 100 bps
- Fee applied per swap step within tick range

**MeteoraDlmm:**
- Dynamic fee = baseFactor * binStep + volatilityComponent
- baseFactor in 1e-10 precision, convert to bps by dividing by 10000
- protocolShare determines LP vs protocol split

**Validation:** Fee document complete with code snippets for each direction and venue

---

#### S1-T15: SimAccuracyTracker Port
**Description:** Port yogurt_bot's SimAccuracyTracker for real-time accuracy monitoring.

**Reference File (read-only):**
- `../../../src/simulation/simAccuracyTracker.ts` (yogurt_bot root)

**Files:**
- `src/instrument/simAccuracy.ts` (create)
- `src/instrument/simAccuracy.spec.ts` (create)

**Acceptance Criteria:**
- `recordPrediction()` for pre-execution sim results
- `recordActual()` for post-execution actual results
- Error calculation: profitErrorBps, tokensErrorPercent, solErrorPercent
- Accuracy stats: by venue pair, by confidence bucket
- Retention: 1 hour rolling window, max 10000 records
- `printReport()` formatted output for console

**Validation:** Tracker records 100 predictions, generates accuracy report

---

## Sprint 2: Instruction Builders (Simple Venues)

**Goal:** Build swap instructions for PumpSwap, RaydiumClmm, and MeteoraDlmm.

**Demo:** Unit tests pass for all instruction builders with fixture data.

**Note:** RaydiumV4 deferred to Sprint 2b due to Serum complexity.

### Tasks

#### S2-T1: Instruction Builder Interface
**Description:** Define common interface for all venue instruction builders.

**Files:**
- `src/execute/ix/types.ts` (create)

**Acceptance Criteria:**
- Interface: `buildSwapInstruction(params: SwapParams): TransactionInstruction`
- SwapParams base: pool, direction, inputAmount, minOutput, userPubkey
- Per-venue extended params (vaults, tick arrays, etc.)
- Return type: programId, keys, data

**Validation:** TypeScript compiles

---

#### S2-T2: Compute Budget Instruction Helpers
**Description:** Build SetComputeUnitLimit and SetComputeUnitPrice instructions.

**Files:**
- `src/execute/ix/computeBudget.ts` (create)
- `src/execute/ix/computeBudget.spec.ts` (create)

**Acceptance Criteria:**
- `buildSetComputeUnitLimit(units: number): TransactionInstruction`
- `buildSetComputeUnitPrice(microLamports: bigint): TransactionInstruction`
- Uses correct program ID: `ComputeBudget111111111111111111111111111111`
- Correct instruction discriminators and serialization

**Validation:** `pnpm test src/execute/ix/computeBudget.spec.ts` passes

---

#### S2-T3: Tip Instruction Builder
**Description:** Build SOL transfer instruction to Jito tip account.

**Files:**
- `src/execute/ix/tip.ts` (create)
- `src/execute/ix/tip.spec.ts` (create)

**Acceptance Criteria:**
- `buildTipInstruction(from: Pubkey, tipLamports: bigint): TransactionInstruction`
- Uses System Program transfer
- `selectTipAccount()` selects random from known Jito list
- All 8 Jito tip accounts represented

**Validation:** `pnpm test src/execute/ix/tip.spec.ts` passes

---

#### S2-T4: PumpSwap Instruction Builder
**Description:** Build PumpSwap swap instruction matching program IDL.

**Files:**
- `src/execute/ix/pumpswap.ts` (create)
- `src/execute/ix/pumpswap.spec.ts` (create)

**Acceptance Criteria:**
- Correct discriminator (8 bytes from Anchor IDL hash of "swap")
- Account ordering matches program:
  - pool, user, userBaseAta, userQuoteAta, baseVault, quoteVault, globalConfig, feeRecipient, systemProgram, tokenProgram
- Serializes inputAmount and minOutput as u64 little-endian
- Tests verify: discriminator bytes, account count, serialization roundtrip

**Validation:** `pnpm test src/execute/ix/pumpswap.spec.ts` passes

---

#### S2-T5: RaydiumClmm Instruction Builder
**Description:** Build RaydiumClmm swap instruction with tick array accounts.

**Files:**
- `src/execute/ix/raydiumClmm.ts` (create)
- `src/execute/ix/raydiumClmm.spec.ts` (create)

**Acceptance Criteria:**
- Correct discriminator from Anchor IDL
- Account ordering: payer, ammConfig, poolState, inputTokenAccount, outputTokenAccount, inputVault, outputVault, observationState, tokenProgram, tickArray0, tickArray1?, tickArray2?
- Serialize sqrtPriceLimitX64 as u128 little-endian
- Tick arrays as remaining accounts (variable count)
- Tests verify: discriminator, account ordering, sqrtPriceLimit serialization

**Validation:** `pnpm test src/execute/ix/raydiumClmm.spec.ts` passes

---

#### S2-T6: MeteoraDlmm Instruction Builder
**Description:** Build MeteoraDlmm swap instruction with bin arrays.

**Files:**
- `src/execute/ix/meteoraDlmm.ts` (create)
- `src/execute/ix/meteoraDlmm.spec.ts` (create)

**Acceptance Criteria:**
- Correct discriminator from Anchor IDL
- Account ordering: lbPair, binArrayBitmapExtension?, reserveX, reserveY, userTokenX, userTokenY, tokenXMint, tokenYMint, oracle, hostFeeIn?, user, tokenXProgram, tokenYProgram, eventAuthority, program
- binArrays as remaining accounts
- Tests verify: discriminator, account ordering, bin array handling

**Validation:** `pnpm test src/execute/ix/meteoraDlmm.spec.ts` passes

---

#### S2-T7: Instruction Builder Router
**Description:** Route to correct builder based on VenueId.

**Files:**
- `src/execute/ix/index.ts` (create)
- `src/execute/ix/index.spec.ts` (create)

**Acceptance Criteria:**
- `buildSwapInstruction(venue, params)` routes to correct builder
- Throws `UnsupportedVenueError` for RaydiumV4 (until S2b)
- Type guards ensure correct params per venue
- Integration test: build instruction for each venue with fixture data

**Validation:** `pnpm test src/execute/ix/index.spec.ts` passes

---

## Sprint 2b: RaydiumV4 + Serum Integration

**Goal:** Complete RaydiumV4 instruction builder with OpenBook/Serum account resolution.

**Demo:** RaydiumV4 swap instruction passes simulation.

**Risk:** This is significantly more complex than other venues. May require 2x task time.

### Tasks

#### S2b-T1: Serum Market Account Types
**Description:** Define types for Serum/OpenBook market accounts.

**Files:**
- `src/execute/ix/serum/types.ts` (create)

**Acceptance Criteria:**
- Types: SerumMarket, OpenOrders, EventQueue, Bids, Asks, VaultSigner
- Address derivation helpers: vaultSignerNonce, openOrdersAuthority

**Validation:** TypeScript compiles

---

#### S2b-T2: Serum Account Resolver
**Description:** Resolve Serum accounts from pool state.

**Files:**
- `src/execute/ix/serum/resolver.ts` (create)
- `src/execute/ix/serum/resolver.spec.ts` (create)

**Acceptance Criteria:**
- `resolveSerumAccounts(poolState: RaydiumV4Pool): Promise<SerumAccounts>`
- Fetch serumMarket account from RPC
- Derive: bids, asks, eventQueue, coinVault, pcVault, vaultSigner from market state
- Cache resolved accounts (market accounts rarely change)

**Validation:** Resolver returns valid accounts for known RaydiumV4 pool

---

#### S2b-T3: RaydiumV4 Instruction Builder
**Description:** Build RaydiumV4 swap instruction with Serum accounts.

**Dependencies:** S2b-T2

**Files:**
- `src/execute/ix/raydiumV4.ts` (create)
- `src/execute/ix/raydiumV4.spec.ts` (create)

**Acceptance Criteria:**
- Correct instruction discriminator (swap = 9)
- Account ordering: amm, authority, openOrders, targetOrders, poolCoin, poolPc, serumProgram, serumMarket, serumBids, serumAsks, serumEventQueue, serumCoinVault, serumPcVault, serumVaultSigner, userSource, userDest, userOwner
- Uses resolved Serum accounts
- Tests: discriminator, full account list, serialization

**Validation:** `pnpm test src/execute/ix/raydiumV4.spec.ts` passes

---

#### S2b-T4: RaydiumV4 Router Integration
**Description:** Update IX router to support RaydiumV4.

**Files:**
- `src/execute/ix/index.ts` (update)
- `src/execute/ix/index.spec.ts` (update)

**Acceptance Criteria:**
- Router accepts VenueId.RaydiumV4
- Serum resolution called automatically
- Integration test with RaydiumV4 fixture

**Validation:** Router builds RaydiumV4 instruction successfully

---

## Sprint 3: Transaction Assembly

**Goal:** Assemble versioned (v0) transactions with proper signing.

**Demo:** Generate valid signed transactions that pass RPC preflight simulation.

**Prerequisites:** S2 complete (S2b optional - can defer RaydiumV4)

### Tasks

#### S3-T1: Transaction Builder with Signing
**Description:** Build v0 transaction messages and sign them.

**Files:**
- `src/execute/transaction.ts` (create)
- `src/execute/transaction.spec.ts` (create)

**Acceptance Criteria:**
- `buildMessageV0(instructions, payer, recentBlockhash, lookupTables?): MessageV0`
- `signTransaction(message, keypairs): VersionedTransaction`
- Handles both with/without ALT
- Properly compiles account keys
- Supports multiple signers
- Produces valid ed25519 signatures

**Validation:** Signed transaction deserializes correctly, signatures verify

---

#### S3-T2: Transaction Size Validation
**Description:** Validate transactions fit within Solana limits.

**Files:**
- `src/execute/transaction.ts` (extend)
- `src/execute/transaction.spec.ts` (extend)

**Acceptance Criteria:**
- `validateTransactionSize(tx): boolean`
- Enforce 1232-byte limit
- Return detailed breakdown if oversized
- Suggest ALT usage if close to limit

**Validation:** Rejects oversized test transaction, accepts valid transaction

---

#### S3-T3: ALT Resolution for Transactions
**Description:** Resolve ALTs from cache for transaction building.

**Files:**
- `src/execute/transaction.ts` (extend)

**Acceptance Criteria:**
- `getAddressLookupTables(altPubkeys): AddressLookupTableAccount[]`
- Uses existing ALT cache (`src/cache/alt.ts`)
- Precondition check: ALT cache populated for required ALTs
- Returns empty array if no ALTs needed

**Validation:** Resolved ALTs match expected address count

---

#### S3-T4: Blockhash Fetcher with Fallback
**Description:** Fetch recent blockhash with caching and fallback.

**Files:**
- `src/execute/blockhash.ts` (create)
- `src/execute/blockhash.spec.ts` (create)

**Acceptance Criteria:**
- `getRecentBlockhash(): Promise<{blockhash, lastValidBlockHeight}>`
- Cache blockhash with 1-second TTL
- RPC health check: fail fast if RPC unresponsive
- Fallback to stale blockhash (up to 30s) with warning
- Track blockhash age for validity window estimation

**Validation:** Returns valid base58 blockhash, fallback triggers on mock RPC failure

---

#### S3-T5: Token Account Validation
**Description:** Validate user has required token accounts before execution.

**Files:**
- `src/execute/accounts.ts` (create)
- `src/execute/accounts.spec.ts` (create)

**Acceptance Criteria:**
- `validateTokenAccounts(user, mints): Promise<TokenAccountStatus[]>`
- Check ATA existence for each mint
- Return: exists, balance, needsCreation
- Optional: create missing ATAs (adds IX to transaction)

**Validation:** Correctly identifies existing/missing ATAs for test wallet

---

#### S3-T6: Full Swap Transaction Builder
**Description:** Combine IX builder + compute budget + transaction assembly.

**Files:**
- `src/execute/bundle.ts` (complete buildSwapTransaction stub)
- `src/execute/bundle.spec.ts` (create)

**Acceptance Criteria:**
- `buildSwapTransaction` no longer throws
- Includes: compute budget IXs (limit + price) + swap IX
- Fetches recent blockhash
- Signs with payer keypair
- Returns signed, serialized transaction
- Transaction size validated

**Validation:** Transaction deserializes correctly, all IXs present

---

#### S3-T7: Tip Transaction Builder
**Description:** Complete tip transaction builder.

**Files:**
- `src/execute/bundle.ts` (complete buildTipTransaction stub)
- `src/execute/bundle.spec.ts` (extend)

**Acceptance Criteria:**
- `buildTipTransaction` no longer throws
- Creates transfer to random Jito tip account
- Uses same blockhash as swap transaction
- Returns signed, serialized transaction

**Validation:** Transaction deserializes with correct recipient

---

#### S3-T8: Bundle Assembly
**Description:** Assemble swap + tip transactions into bundle.

**Files:**
- `src/execute/bundle.ts` (complete buildBundle)
- `src/execute/bundle.spec.ts` (extend)

**Acceptance Criteria:**
- `buildBundle` returns `BundleRequest` with both TXs
- Order: swap TX first, tip TX second
- Both transactions properly signed
- Bundle passes internal validation (sizes, signatures)

**Validation:** Bundle contains 2 valid transactions

---

#### S3-T9: Preflight Simulation Gate
**Description:** All transactions must pass simulation before bundling.

**Files:**
- `scripts/test-preflight.ts` (create)
- `src/execute/bundle.ts` (extend)

**Acceptance Criteria:**
- `simulateTransaction(tx): SimulationResult`
- Check: success, consumed CU < budget, no account errors
- Gate bundle building: simulation must pass
- Log simulation errors with decoded logs

**Validation:** At least 1 simulated transaction succeeds (with test wallet)

---

## Sprint 4: Jito Bundle Submission

**Goal:** Submit bundles to Jito block engine and track landing.

**Demo:** Submit test bundle to Jito, observe accepted/rejected status.

**Prerequisites:** S3 complete

### Tasks

#### S4-T1: Jito Authentication
**Description:** Handle Jito authentication/UUID for production access.

**Files:**
- `src/execute/jito/auth.ts` (create)

**Acceptance Criteria:**
- Load Jito UUID from env (`JITO_UUID`)
- Support UUID rotation
- Handle auth token refresh if required
- Graceful fallback to public endpoint (with rate limits)

**Validation:** Auth token included in requests

---

#### S4-T2: Jito RPC Client
**Description:** HTTP client for Jito block engine RPC.

**Files:**
- `src/execute/jito/client.ts` (create)
- `src/execute/jito/client.spec.ts` (create)

**Acceptance Criteria:**
- `sendBundle(transactions: string[]): Promise<string>` (bundle UUID)
- Serializes to Jito JSON-RPC format
- Includes auth header if configured
- Handles HTTP errors: 400 (bad request), 429 (rate limit), 500 (server error)
- Returns bundle UUID on success

**Validation:** Receives bundle UUID on test submission (mock or real)

---

#### S4-T3: Jito Mock Server
**Description:** Mock server for testing Jito submissions.

**Files:**
- `src/test/jito-mock.ts` (create)

**Acceptance Criteria:**
- Mock sendBundle: return UUID, simulate rate limit, simulate rejection
- Mock getBundleStatuses: return pending/landed/dropped
- Configurable response latency
- Used in CI tests

**Validation:** Mock server responds correctly to test requests

---

#### S4-T4: Bundle Status Polling
**Description:** Poll Jito for bundle landing status.

**Files:**
- `src/execute/jito/client.ts` (extend)

**Acceptance Criteria:**
- `getBundleStatus(uuid): Promise<BundleStatus>`
- Returns: pending, landed, dropped, expired
- Includes landed slot if applicable
- Polling interval: 200ms, max 5 attempts

**Validation:** Status check returns valid enum value

---

#### S4-T5: Jito Error Classification
**Description:** Parse and classify Jito rejection reasons.

**Files:**
- `src/execute/jito/errors.ts` (create)
- `src/execute/jito/errors.spec.ts` (create)

**Acceptance Criteria:**
- Classify: rate_limited, simulation_failed, bundle_expired, slot_expired, already_processed, unknown
- Extract relevant error details (error message, context)
- Map to actionable retry strategy: retry_immediate, retry_backoff, skip

**Validation:** Known error responses correctly classified

---

#### S4-T6: Submit with Retry Logic
**Description:** Complete JitoClient.submitBundle with retries.

**Files:**
- `src/execute/submit.ts` (complete stubs)
- `src/execute/submit.spec.ts` (create)

**Acceptance Criteria:**
- Exponential backoff on rate limit (429): 100ms, 200ms, 400ms...
- Max retries configurable (default 3)
- Returns final status after polling
- Metrics: retries_count, final_status

**Validation:** Retry logic triggers on simulated 429 (mock server)

---

#### S4-T7: Executor Core
**Description:** Wire bundle builder → Jito submission.

**Files:**
- `src/execute/executor.ts` (create)

**Acceptance Criteria:**
- `execute(opportunity, config): Promise<ExecutionResult>`
- Steps: build bundle → simulate → submit → poll status
- Simulation gate: skip submission if simulation fails
- Returns: bundleId, submitted, landed, slot, error, latencyMs

**Validation:** TypeScript compiles, mock test passes

---

#### S4-T8: Executor Status Integration
**Description:** Integrate status polling into executor.

**Files:**
- `src/execute/executor.ts` (extend)

**Acceptance Criteria:**
- Poll status after submission
- Update ExecutionResult with final status
- Log outcome (landed/dropped/expired)

**Validation:** Full execution flow completes with status

---

#### S4-T9: Submission Metrics
**Description:** Track bundle submission metrics.

**Files:**
- `src/execute/executor.ts` (extend)
- `src/instrument/metrics.ts` (extend)

**Acceptance Criteria:**
- Increment: bundlesSubmitted, bundlesLanded, bundlesFailed
- Record histograms: build_latency_us, submission_latency_ms, landing_latency_ms
- Log failed bundles with reason

**Validation:** Metrics increment on test execution

---

#### S4-T10: Dry Run Mode
**Description:** Executor mode that simulates but doesn't submit.

**Files:**
- `src/execute/executor.ts` (extend)

**Acceptance Criteria:**
- `execute(opportunity, config, {dryRun: true})`
- Builds bundle, simulates, logs, but skips Jito submission
- Returns simulated result with dryRun flag

**Validation:** Dry run completes without network call to Jito

---

#### S4-T11: Health Check Endpoint
**Description:** HTTP endpoint for monitoring health.

**Files:**
- `src/health.ts` (create)

**Acceptance Criteria:**
- GET /health returns: status (up/degraded/down), uptime, component statuses
- GET /metrics returns Prometheus format
- Metrics include: bundles_submitted_total, bundles_landed_total, sim_latency_histogram, cache_hit_rate, pending_opportunities_gauge
- Listens on configurable port (env: `HEALTH_PORT`)

**Validation:** curl /health returns valid JSON, curl /metrics returns Prometheus format

---

#### S4-T12: Live Submission Test Script
**Description:** Manual test script for live bundle submission.

**Files:**
- `scripts/test-jito-submission.ts` (create)

**Acceptance Criteria:**
- Takes: pool, venue, direction, amount, tipLamports as args
- Builds and submits real bundle to Jito
- Outputs: bundle UUID, status, slot if landed, latency

**Validation:** Script runs and reports status

---


## Sprint 4.5: Speculative Pending Deltas (Order-Aware Replay Overlay)

**Goal:** Implement a **high-ROI speculative state layer** that predicts post-pending pool reserves by **replaying pending swap operations in deterministic order**, without mutating confirmed cache state.

**Why this sprint exists:** Summing “deltas” is incorrect for CPMM when multiple pending swaps touch the same pool (output depends on prior reserve updates). The correct approach is **per-pool ordered replay**.

**Demo:** Run a live overlay demo and an evidence-based validation:
- `pnpm demo:speculative` (prints overlay stats while streaming)
- `pnpm validate:speculative` (compares predicted reserve deltas vs evidence-derived post-state)

**Prerequisites:** S0 complete (types + decodeTx instructions), Phase 4 pending stream operational.

### Tasks

#### S45-T1: Export Signed-TX Parser Utilities (Testable)
**Description:** Refactor tx parsing logic from `src/ingest/shred.ts` into a small utility module that can be unit tested using serialized `@solana/web3.js` transactions.

**Files:**
- `src/ingest/signedTx.ts` (create)
- `src/ingest/signedTx.spec.ts` (create)
- `src/ingest/shred.ts` (refactor to use utility)

**Acceptance Criteria:**
- Exported functions:
  - `getSignedTxSize(buf: Uint8Array, offset: number): number`
  - `parseSignedTx(buf: Uint8Array, start: number, end: number): { signature: Uint8Array; message: Uint8Array; rawTx: Uint8Array } | null`
- Unit tests generate a signed tx via `@solana/web3.js`, serialize it, and assert:
  - extracted signature matches tx.signature
  - extracted message matches tx.message.serialize()
  - rawTx matches original serialized bytes

**Validation:** `pnpm test src/ingest/signedTx.spec.ts` passes

---

#### S45-T2: Pending Order Key Generation in ShredStream Consumer
**Description:** Attach a deterministic order key to each pending tx emitted from ShredStream (observed order).

**Files:**
- `src/ingest/shred.ts` (update)
- `src/ingest/shred.spec.ts` (create)

**Acceptance Criteria:**
- Maintain a per-slot monotonic sequence counter (bounded map keyed by slot)
- Emit `TxUpdate.pendingOrder` as: `(BigInt(slot) << 32n) | BigInt(seq)`
- Emit `TxUpdate.rawTx` (full signed tx bytes) alongside `message`
- Order key is strictly increasing within a slot for the duration of the process
- Map cleanup: drop counters for slots < headSlot - 512 to bound memory

**Validation:**
- Unit test feeds two “synthetic” txs through the order assigner and asserts order monotonicity
- Smoke test: `pnpm demo:speculative` logs non-null `pendingOrder` and `rawTx` for pending txs

---

#### S45-T3: Evidence Capture Upgrade (Pending Order + Raw TX Bytes)
**Description:** Extend evidence capture to store pending tx order and raw tx bytes for offline replay and deterministic debugging.

**Files:**
- `scripts/capture-evidence.ts` (update)
- `scripts/verify-evidence-schema.ts` (update; from S1-T0)

**Acceptance Criteria:**
- `pending_shreds` table gains columns (idempotent migration):
  - `receive_ts_ns INTEGER` (nanoseconds)
  - `pending_order TEXT` (stringified bigint)
  - `raw_tx_b64 TEXT` (base64 full signed tx bytes)
- Insert path writes all fields for each pending tx event
- Schema verification script asserts columns exist

**Validation:**
- Run `pnpm evidence 30` and confirm:
  - `SELECT COUNT(*) FROM pending_shreds WHERE raw_tx_b64 IS NOT NULL;` returns > 0
  - `pending_order` populated for > 99% rows

---

#### S45-T4: PendingTxQueue Ordering by pendingOrder
**Description:** Make pending ordering reflect your observed pending stream order, not signature lexicographic order.

**Files:**
- `src/pending/queue.ts` (update)
- `src/pending/queue.spec.ts` (create)

**Acceptance Criteria:**
- `PendingTxEntry` includes `pendingOrder?: bigint`
- `getOrdered()` sorts by:
  1) `pendingOrder` (ASC) when present
  2) fallback `(slot ASC, signature ASC)` when missing
- `expireOld()` uses `headSlot` unchanged
- `getForPool()` unaffected

**Validation:** Unit test inserts 3 entries same slot, different `pendingOrder`, verifies stable ordering

---

#### S45-T5: SwapLeg SwapMode (ExactIn/ExactOut) + Decoder Updates
**Description:** Update decoders so pending overlay can apply swaps correctly (exact-in vs exact-out matters for reserve deltas).

**Files:**
- `src/types.ts` (update: SwapMode + SwapLeg.swapMode)
- `src/decode/programs/pumpswap.ts` (update)
- `src/decode/programs/raydiumV4.ts` (update)
- `src/decode/programs/raydiumClmm.ts` (update, even if not used in CPMM overlay yet)
- `src/decode/programs/meteoraDlmm.ts` (update, even if not used in CPMM overlay yet)
- `src/decode/programs/*.spec.ts` (create minimal tests for PumpSwap + RaydiumV4)

**Acceptance Criteria:**
- PumpSwap:
  - `sell` => `swapMode=ExactIn`
  - `buy`  => `swapMode=ExactOut` (baseAmountOut exact, maxQuoteIn cap)
- RaydiumV4:
  - `swapBaseIn`  => `swapMode=ExactIn`
  - `swapBaseOut` => `swapMode=ExactOut`
  - `baseVault`/`quoteVault` populated from instruction accounts (poolCoinVault/poolPcVault)
- Unit tests validate swapMode assignment for synthetic compiled instructions

**Validation:** `pnpm test` passes for decoder specs

---

#### S45-T6: CPMM Pending Apply Engine (Correct Fee Placement + ExactOut)
**Description:** Implement a small library that applies a swap leg to reserves (pure function) for CPMM venues, supporting exact-in and exact-out.

**Files:**
- `src/pending/cpmmApply.ts` (create)
- `src/pending/cpmmApply.spec.ts` (create)
- `src/sim/math/constantProduct.ts` (update if required to share logic)

**Acceptance Criteria:**
- Export `applyCpmmSwapToReserves(params)`:
  - inputs: venue, direction, swapMode, amountSpecified, reserves, feeParams
  - outputs: `{ newReserveA, newReserveB, amountIn, amountOut, feePaid }`
- ExactIn:
  - compute amountOut with correct fee placement for the venue/direction (per S1-T9 findings)
- ExactOut:
  - compute required amountIn, apply caps (maxIn), and compute resulting reserves
- Deterministic rounding policy matches on-chain within 1 unit for test vectors
- Include test vectors for:
  - PumpSwap buy (ExactOut) + sell (ExactIn)
  - RaydiumV4 exactIn + exactOut

**Validation:** `pnpm test src/pending/cpmmApply.spec.ts` passes

---

#### S45-T7: Order-Aware Speculative Replay Overlay (CPMM MVP)
**Description:** Replace “sum deltas” with **per-pool ordered replay**. Store pending swap ops and compute speculative reserves on demand by replaying in order.

**Files:**
- `src/pending/speculativeReplay.ts` (create)
- `src/pending/speculativeReplay.spec.ts` (create)
- `src/pending/speculative.ts` (deprecate or refactor to wrap new overlay)

**Acceptance Criteria:**
- Core API:
  - `addPendingTx(entry: PendingTxEntry): void` (extracts legs, creates per-pool ops)
  - `removePendingTx(signature: Uint8Array): void` (removes ops by sig)
  - `expire(headSlot: number): number` (returns ops removed)
  - `getSpeculativeReserves(pool: Uint8Array): SpeculativeSnapshot | null` (confirmed reserves + replay)
- Replay semantics:
  - replays only legs that touch the requested pool
  - deterministic ordering by `(pendingOrder, legIndex)`
  - does not mutate confirmed cache state
- Performance:
  - caches per-pool replay result and invalidates on insert/remove/expire
  - target: `getSpeculativeReserves()` < 200µs for pools with <= 50 pending ops

**Validation:** Unit tests cover:
- two pending swaps same pool applied in order
- removal of earlier tx triggers recompute and correct outcome
- exactOut leg application produces expected reserve transitions

---

#### S45-T8: Phase 4 Wiring — Populate Pending Queue + Overlay
**Description:** Wire pending tx decode into pending queue and speculative overlay.

**Files:**
- `src/handler/phase4.ts` (update: include pendingOrder/rawTx on callback)
- `src/pending/index.ts` (create wiring helper)
- `src/pending/index.spec.ts` (create)

**Acceptance Criteria:**
- On pending decoded tx:
  - extract legs via `extractSwapLegs(tx, tx.instructions, poolLookup?)`
  - enqueue `PendingTxEntry` (includes pendingOrder, receivedAtNs, rawUpdate)
  - add to speculative overlay
- On confirmed tx (if present in pipeline):
  - call `removePendingTx(signature)` to clear overlay entries
- If confirmed feed is not wired yet:
  - expiration runs based on head slot

**Validation:** Integration test feeds a synthetic sequence:
- pending tx A affects pool P
- pending tx B affects pool P
- overlay returns reserves reflecting A then B
- confirm A removes A and overlay recomputes correctly

---

#### S45-T9: Evidence-Based Speculative Validation (CPMM)
**Description:** Use `capture.db` to validate that applying a confirmed swap as “pending” predicts the observed vault reserve delta at confirmation.

**Files:**
- `scripts/validate-speculative.ts` (create)
- `package.json` (add script: `validate:speculative`)

**Acceptance Criteria:**
- For CPMM venues (PumpSwap + RaydiumV4):
  - Load N swaps from `parsed_swaps`
  - Reconstruct pre-reserves from `cache_traces` vault rows at slot <= swap.slot-1
  - Apply swap via `applyCpmmSwapToReserves()`
  - Reconstruct post-reserves from `cache_traces` vault rows at slot >= swap.slot
  - Report: mean error, p95/p99 error, pass rate (<=10 bps reserve error)
- Exit non-zero if pass rate < 99%

**Validation:** `pnpm validate:speculative` produces report JSON + exits 0 on pass


---

#### S45-T10: Overlay Observability (Metrics + Debug Dumps)
**Description:** Add low-overhead observability for speculative overlay so you can diagnose mismatches and performance regressions before going live.

**Files:**
- `src/pending/speculativeReplay.ts` (extend)
- `src/pending/metrics.ts` (create)
- `src/pending/metrics.spec.ts` (create)

**Acceptance Criteria:**
- Export counters/histograms:
  - `pending_ops_total`, `pending_pools_tracked`, `overlay_replay_us_histogram`, `overlay_cache_hit_rate`
- Provide `dumpPoolOverlay(poolPubkey)` that returns:
  - ordered list of pending ops (sig, pendingOrder, legIndex, venue, swapMode, amount)
  - last computed reserves and confirmed baseline
- Debug dumps are gated by config `DEBUG=1` or `enableOverlayDebugDump`

**Validation:** Unit tests verify metric increments + dump formatting; demo prints overlay histograms


---

#### S45-T11: Speculative Overlay Live Demo Script
**Description:** Provide a single command that proves the overlay is working end-to-end with your current infrastructure (pending shreds → decode → overlay → stats).

**Files:**
- `scripts/demo-speculative.ts` (create)
- `package.json` (add script: `demo:speculative`)

**Acceptance Criteria:**
- `pnpm demo:speculative`:
  - connects to ShredStream (pending) and (optionally) gRPC confirmed feeds
  - prints once per second:
    - pending tx/s, decode p99, pools tracked, ops tracked
    - overlay replay p50/p95 in µs, overlay cache hit rate
  - supports `POOL=<pubkey>` env var to print a detailed `dumpPoolOverlay()` every N seconds
- Exits cleanly on SIGINT

**Validation:** Demo runs for 60s with stable memory usage and produces expected counters

## Sprint 5: Opportunity Detection

**Goal:** Detect profitable backrun opportunities from pending transactions.

**Demo:** Live feed of detected opportunities with profit estimates.

**Prerequisites:** S1 complete (validated simulation), S0 types available

### Tasks

#### S5-T1: Pending TX Filter
**Description:** Filter pending TXs for swap-containing transactions.

**Files:**
- `src/opportunity/filter.ts` (create)
- `src/opportunity/filter.spec.ts` (create)

**Acceptance Criteria:**
- `isSwapTransaction(decodedTx): boolean`
- Filter to supported venues only (PumpSwap, RaydiumV4, RaydiumClmm, MeteoraDlmm)
- Reject multi-pool atomic swaps (can't profitably backrun)
- Reject failed decodes

**Validation:** Correctly filters test fixtures (swap/non-swap/multi-pool)

---

#### S5-T2: Priority Fee Estimator
**Description:** Estimate priority fee costs for profit calculation.

**Files:**
- `src/opportunity/fees.ts` (create)
- `src/opportunity/fees.spec.ts` (create)

**Acceptance Criteria:**
- `estimatePriorityFee(computeUnits): bigint` (in lamports)
- Track recent landed bundle fees (rolling window)
- Provide p50/p75/p95 estimates
- Fallback to configured default if insufficient data

**Validation:** Returns reasonable fee estimate (10-10000 microlamports/CU)

---

#### S5-T3: Backrun Profit Calculator
**Description:** Calculate expected profit from backrunning a swap.

**Files:**
- `src/opportunity/profit.ts` (create)
- `src/opportunity/profit.spec.ts` (create)

**Acceptance Criteria:**
- `calculateBackrunProfit(triggerSwap, poolState, inputAmount, tickArrays?, binArrays?): ProfitEstimate`
- Simulate: trigger swap → pool state change → our swap
- Return: grossProfit, estimatedTip, netProfit, breakeven input
- Use validated simulation from S1

**Validation:** Automated tests against 10 known fixtures (not manual)

---

#### S5-T4: Optimal Input Size Calculator
**Description:** Find optimal input amount for maximum profit.

**Files:**
- `src/opportunity/profit.ts` (extend)
- `src/opportunity/profit.spec.ts` (extend)

**Acceptance Criteria:**
- `findOptimalInput(triggerSwap, poolState, maxInput): OptimalResult`
- Binary search with early termination (max 8 iterations)
- Respect slippage and max position constraints
- Performance: complete in <5ms

**Validation:** Returns input that beats 3 test points, completes in time budget

---

#### S5-T5: Opportunity Detector
**Description:** Main detector that processes pending TXs.

**Files:**
- `src/opportunity/detector.ts` (create)
- `src/opportunity/detector.spec.ts` (create)

**Acceptance Criteria:**
- `detectOpportunities(decodedTx, caches): Opportunity[]`
- Filters → calculates profit → creates Opportunity objects
- Applies minimum profit threshold (configurable, default 1000 lamports)
- Returns empty array for non-profitable

**Validation:** Returns opportunities for profitable test cases, empty for unprofitable

---

#### S5-T6: Speculative Replay Overlay Integration
**Description:** Use the order-aware speculative overlay (Sprint 4.5) so profit sizing runs against **post-pending** reserves, not confirmed reserves.

**Files:**
- `src/opportunity/detector.ts` (extend)
- `src/pending/speculativeReplay.ts` (import + use)

**Acceptance Criteria:**
- Detector uses `getSpeculativeReserves(pool)` as the baseline reserve snapshot when available
- Handles multiple pending TXs affecting the same pool by replaying in `(pendingOrder, legIndex)` order
- Expiration handling:
  - ignore/reject pending entries older than `N` slots behind head (configurable; default 10)
  - never use speculative snapshot older than confirmedSlot by more than `M` slots (stale guard)
- If speculative snapshot cannot be built (missing vaults/pool state), detector falls back to confirmed reserves **and lowers confidence** in ProfitEstimate

**Validation:** Unit test constructs:
- confirmed reserves
- two pending legs same pool
- detector produces different optimalInput/profit when speculative overlay is enabled vs disabled

---

#### S5-T7: Opportunity Queue
**Description:** Priority queue for opportunities by expected profit.

**Files:**
- `src/opportunity/queue.ts` (create)
- `src/opportunity/queue.spec.ts` (create)

**Acceptance Criteria:**
- `OpportunityQueue`: insert, pop (highest profit first), peek, size, expire
- Deduplication by trigger signature + pool
- Slot-based expiration (configurable, default 5 slots)
- Max queue size (configurable, default 1000)

**Validation:** Pop order matches profit ranking, expiration works correctly

---

#### S5-T8: Opportunity Logger
**Description:** Log all detected opportunities for analysis.

**Files:**
- `src/opportunity/logger.ts` (create)

**Acceptance Criteria:**
- JSONL output: `data/opportunities-detected.jsonl`
- Fields: timestamp_ns, slot, triggerSig, pool, venue, direction, inputAmount, expectedProfit, estimatedTip, netProfit, executed (boolean, updated later)
- Async buffered writes (no hot path blocking)
- Rotation: new file per day

**Validation:** Log file created with valid JSON lines

---

## Sprint 6: End-to-End Execution

**Goal:** Full pipeline from pending TX to landed bundle.

**Demo:** Bot running live, detecting opportunities, submitting bundles.

**Prerequisites:** S3, S4, S5 complete

### Tasks

#### S6-T1: Pipeline Skeleton
**Description:** Main entry point with component initialization.

**Files:**
- `src/main.ts` (create)

**Acceptance Criteria:**
- Load configuration (S0-T4)
- Initialize logger (S0-T5)
- Initialize wallet (S0-T3)
- Setup signal handlers (SIGINT, SIGTERM)
- Clean exit with resource cleanup

**Validation:** Starts, logs initialization, exits cleanly on SIGINT

---

#### S6-T2: Phase Wiring
**Description:** Wire all pipeline phases together.

**Files:**
- `src/main.ts` (extend)

**Acceptance Criteria:**
- Starts: gRPC ingest, ShredStream ingest
- Wires: decode → cache → topology → snapshot (existing Phase 2/3/4)
- Logs phase transitions

**Validation:** Existing phases run, logs show data flow

---

#### S6-T3: Detection Handler (Phase 5b)
**Description:** Wire pending TXs to opportunity detector.

**Files:**
- `src/handler/detection.ts` (create)

**Acceptance Criteria:**
- Receives decoded pending TXs from Phase 4
- Calls opportunity detector (S5-T5)
- Enqueues opportunities (S5-T7)
- Logs detected opportunities

**Validation:** Opportunities detected from live pending stream

---

#### S6-T4: Execution Handler (Phase 8)
**Description:** Wire opportunity queue to executor.

**Files:**
- `src/handler/execution.ts` (create)

**Acceptance Criteria:**
- Polls opportunity queue
- Checks profit > tip + minProfit threshold
- Calls executor.execute()
- Updates opportunity log with execution result

**Validation:** Execution attempted for queued opportunities

---

#### S6-T5: Graceful Shutdown
**Description:** Proper shutdown handling for all components.

**Files:**
- `src/main.ts` (extend)
- `src/shutdown.ts` (create)

**Acceptance Criteria:**
- On SIGINT/SIGTERM: stop accepting new TXs
- Drain opportunity queue (with timeout)
- Close gRPC/ShredStream connections
- Flush logs and metrics
- Exit 0 on clean shutdown, 1 on timeout

**Validation:** Clean shutdown completes within 5s

---

#### S6-T6: Circuit Breaker
**Description:** Automatic shutdown on excessive losses.

**Files:**
- `src/circuitBreaker.ts` (create)
- `src/circuitBreaker.spec.ts` (create)

**Acceptance Criteria:**
- Track: consecutive losses, total loss amount
- Trip conditions: N consecutive losses OR X total loss in window
- Actions: pause execution, alert, optionally shutdown
- Reset: manual reset via /health endpoint or auto after cooldown
- Configurable thresholds

**Validation:** Circuit trips on configured loss conditions

---

#### S6-T7: Rate Limiting
**Description:** Proactive rate limiting for Jito/RPC.

**Files:**
- `src/rateLimit.ts` (create)
- `src/rateLimit.spec.ts` (create)

**Acceptance Criteria:**
- Token bucket rate limiter
- Separate limits for: Jito submissions, RPC calls
- Configurable: max rate, burst size
- Metrics: requests_allowed, requests_throttled

**Validation:** Throttles requests exceeding limit

---

#### S6-T8: Graceful Degradation
**Description:** Handle component failures gracefully.

**Files:**
- `src/degradation.ts` (create)

**Acceptance Criteria:**
- gRPC disconnect: attempt reconnect, pause detection during reconnect
- RPC failure: use cached blockhash, warn on stale data
- Jito failure: queue opportunities for retry
- Health endpoint reflects degraded state

**Validation:** System continues operating in degraded mode

---

#### S6-T9: Live Run Script
**Description:** Script to run full pipeline.

**Files:**
- `scripts/run-live.ts` (create)

**Acceptance Criteria:**
- Start pipeline with all configuration
- Support DRY_RUN=1 mode (detect but don't submit)
- Log: pending TXs/s, opportunities/s, submissions/s
- Prometheus metrics exposed

**Validation:** Script runs in dry-run mode, logs flow

---

#### S6-T10: Live Test (Real Submission)
**Description:** Run full pipeline with real bundle submission.

**Files:**
- Documentation only

**Acceptance Criteria:**
- Run with funded wallet and DRY_RUN=0
- Observe: bundle submitted to Jito
- Success criteria: bundle passes Jito preflight (landing is market-dependent)

**Validation:** Bundle submission confirmed in logs

---

## Sprint 7: Hardening & Observability

**Goal:** Production-ready error handling and monitoring.

**Demo:** Comprehensive monitoring dashboard and error recovery.

**Prerequisites:** S6 complete

### Tasks

#### S7-T1: Error IDL Mappings (All Venues)
**Description:** Map program error codes to ErrorClass for all venues.

**Files:**
- `src/decode/error.ts` (extend)
- `src/decode/error.spec.ts` (create)

**Acceptance Criteria:**
- Parse error codes from: PumpSwap (6000+), RaydiumV4, RaydiumClmm, MeteoraDlmm
- Map to: Slippage, InsufficientLiquidity, InvalidAccount, MathOverflow, Unknown
- Handle anchor error format and raw error codes
- Unknown codes → ErrorClass.Unknown with raw info preserved

**Validation:** Known error codes correctly classified for all venues

---

#### S7-T2: Execution Error Recovery
**Description:** Automatic recovery from transient errors.

**Files:**
- `src/execute/executor.ts` (extend)
- `src/execute/recovery.ts` (create)

**Acceptance Criteria:**
- Retry strategy by error type:
  - rate_limit: backoff retry
  - network_error: immediate retry (1x)
  - simulation_failed: skip (opportunity stale)
  - slippage: skip (market moved)
- Track recovery attempts per opportunity
- Backoff on repeated failures

**Validation:** Recovery behavior in error injection test

---

#### S7-T3: Reverse Simulation
**Description:** Calculate required input for target output.

**Files:**
- `src/sim/sequential.ts` (complete TODO)
- `src/sim/sequential.spec.ts` (extend)

**Acceptance Criteria:**
- `calculateRequiredInput(targetOutput, path, poolStates): bigint`
- Works backwards through path
- Handles fees correctly (adds fee to required input)
- Iterative approximation for CLMM/DLMM (closed-form not available)

**Validation:** Reverse calc matches forward calc within 0.1% tolerance

---

#### S7-T4: Replay Validation Script
**Description:** Validate execution decisions against captured evidence.

**Files:**
- `scripts/replay-validate.ts` (create)

**Acceptance Criteria:**
- Replay pending TXs from evidence DB
- Compare: detected opportunities vs actual profitability (from confirmed TXs)
- Report: true positives (profitable and detected), false positives (detected but not profitable), false negatives (profitable but missed)
- Metrics: precision, recall, profit capture rate

**Validation:** Report generated with classification metrics

---

#### S7-T5: Deployment Runbook
**Description:** Document operational procedures.

**Files:**
- `docs/RUNBOOK.md` (create)

**Acceptance Criteria:**
- Startup procedure
- Shutdown procedure
- Common issues and resolutions
- Rollback procedure
- Monitoring alerts and responses
- Contact/escalation info

**Validation:** Document reviewed and complete

---

#### S7-T6: End-to-End Regression Test
**Description:** Automated regression test using evidence replay.

**Files:**
- `scripts/regression-test.ts` (create)

**Acceptance Criteria:**
- Replay evidence DB in simulation mode
- Compare detected opportunities to baseline
- Fail if opportunity detection regresses (>5% fewer detected)
- Fail if simulation accuracy regresses

**Validation:** Regression test passes against current baseline

---

---

## Appendix A: File Index

### New Files by Sprint

**Sprint 0:**
- `vitest.config.ts`
- `src/opportunity/types.ts`
- `src/wallet.ts` + spec
- `src/config.ts` + spec
- `src/logger.ts`

**Sprint 1:**
- `scripts/verify-evidence-schema.ts`
- `scripts/validate-simulation.ts`
- `scripts/canonical-regression.ts`
- `data/canonical/` (directory)
- `src/sim/math/constantProduct.spec.ts`
- `src/sim/math/clmm.spec.ts`
- `src/sim/math/dlmm.spec.ts`
- `src/sim/sequential.spec.ts`
- `src/instrument/simAccuracy.ts` + spec
- `docs/FEE_STRUCTURES.md`

**Sprint 2:**
- `src/execute/ix/types.ts`
- `src/execute/ix/computeBudget.ts` + spec
- `src/execute/ix/tip.ts` + spec
- `src/execute/ix/pumpswap.ts` + spec
- `src/execute/ix/raydiumClmm.ts` + spec
- `src/execute/ix/meteoraDlmm.ts` + spec
- `src/execute/ix/index.ts` + spec

**Sprint 2b:**
- `src/execute/ix/serum/types.ts`
- `src/execute/ix/serum/resolver.ts` + spec
- `src/execute/ix/raydiumV4.ts` + spec

**Sprint 3:**
- `src/execute/transaction.ts` + spec
- `src/execute/blockhash.ts` + spec
- `src/execute/accounts.ts` + spec
- `src/execute/bundle.spec.ts`
- `scripts/test-preflight.ts`

**Sprint 4:**
- `src/execute/jito/auth.ts`
- `src/execute/jito/client.ts` + spec
- `src/execute/jito/errors.ts` + spec
- `src/test/jito-mock.ts`
- `src/execute/executor.ts`
- `src/execute/submit.spec.ts`
- `src/health.ts`
- `scripts/test-jito-submission.ts`

**Sprint 5:**
- `src/opportunity/filter.ts` + spec
- `src/opportunity/fees.ts` + spec
- `src/opportunity/profit.ts` + spec
- `src/opportunity/detector.ts` + spec
- `src/opportunity/queue.ts` + spec
- `src/opportunity/logger.ts`

**Sprint 6:**
- `src/main.ts`
- `src/handler/detection.ts`
- `src/handler/execution.ts`
- `src/shutdown.ts`
- `src/circuitBreaker.ts` + spec
- `src/rateLimit.ts` + spec
- `src/degradation.ts`
- `scripts/run-live.ts`

**Sprint 7:**
- `src/decode/error.spec.ts`
- `src/execute/recovery.ts`
- `scripts/replay-validate.ts`
- `scripts/regression-test.ts`
- `docs/RUNBOOK.md`

---

## Appendix B: Dependency Graph

```
S0 (Infra) ──────────────────────────────────────────────────────────┐
    │                                                                 │
    ├── S1 (Sim Validation) ─────────────────────────────┐           │
    │                                                     │           │
    └── S2 (IX Builders) ─────┬── S2b (RaydiumV4) ───────┤           │
                              │                           │           │
                              └── S3 (TX Assembly) ──────┤           │
                                        │                 │           │
                                        └── S4 (Jito) ───┼───────────┼── S6 (E2E)
                                                         │           │      │
                              S5 (Opportunity) ──────────┘           │      │
                                   │                                  │      │
                                   └──────────────────────────────────┘      │
                                                                             │
                                                                   S7 (Hardening)
```

**Critical Path:** S0 → S2 → S3 → S4 → S6 → S7

**Parallelization Opportunities:**
- S1 runs in parallel with S2
- S5 can start after S1 (needs validated sim)
- Within S2: T2, T3 independent of venue builders
- Within S5: T1, T7 independent of profit calculation

---

## Appendix C: Risk Registry

| ID | Risk | Sprint | Mitigation |
|----|------|--------|------------|
| R1 | RaydiumV4 Serum complexity | S2b | Isolated sprint, can skip initially |
| R2 | Jito rate limits at scale | S4 | Proactive rate limiting (S6-T7) |
| R3 | Simulation accuracy edge cases | S1 | Fuzzing tests, regression monitoring |
| R4 | Optimal input calculation latency | S5 | Max 8 iterations, time budget |
| R5 | Excessive losses | S6 | Circuit breaker (S6-T6) |
| R6 | gRPC disconnection | S6 | Graceful degradation (S6-T8) |
| R7 | Reverse simulation math complexity | S7 | Iterative approximation, mark P2 if blocked |
| R8 | **PumpSwap fee discrepancy** | S1 | Yogurt CPMM applies fee pre-swap; PumpSwap SELL requires fee on output. S1-T9 must fix or create venue-specific sim |
| R9 | AmmConfig not streamed | S1 | CLMM AmmConfig is read-only. S1-T10 requires fetcher with cache at topology freeze |
| R10 | Tick array TTL staleness | S1 | DewdSoup/mev uses 3s TTL. Document recommended cache TTL in S1-T10 |

---

## Appendix D: Definition of Done

Each task is complete when:

1. **Code:** Implementation complete, follows existing patterns
2. **Tests:** Unit tests pass (or validation script passes)
3. **Types:** TypeScript compiles with no errors
4. **Docs:** Inline comments for non-obvious logic
5. **Review:** Self-review checklist complete
6. **Commit:** Atomic commit with descriptive message

Each sprint is complete when:

1. **All tasks:** Complete per task DoD
2. **Integration:** Components work together
3. **Demo:** Demo deliverable functional
4. **Typecheck:** `pnpm typecheck` passes
5. **Tests:** `pnpm test` passes

---

## Appendix E: Existing DewdSoup/mev Repository Reference

**Repository:** https://github.com/DewdSoup/mev

**Access Method:** GitHub MCP server tools available in this environment. Use `mcp__github__get_file_contents` with `owner: "DewdSoup"`, `repo: "mev"` to retrieve file contents.

### Repository Structure

```
DewdSoup/mev/
├── packages/
│   ├── amms/src/adapters/     # AMM venue adapters
│   ├── core/                   # Core utilities
│   ├── executor/src/           # Transaction execution
│   ├── jito/src/               # Jito integration
│   ├── phoenix/src/            # Phoenix CLOB integration
│   ├── risk/src/               # Risk management
│   ├── router/src/             # Route building
│   ├── rpc-facade/             # RPC abstraction
│   ├── solana/                 # Solana utilities
│   └── storage/                # Data persistence
├── services/
│   └── arb-mm/src/             # Arbitrage/market-making service
└── package.json                # Monorepo root
```

### Package Contents

#### packages/amms/src/adapters/

| File | Size | Description |
|------|------|-------------|
| `base.ts` | 1.2KB | AmmAdapter interface definition |
| `orca.ts` | 6KB | Orca Whirlpool adapter |
| `raydium.ts` | 8.7KB | Raydium CPMM adapter |
| `raydium_clmm.ts` | 11.6KB | Raydium CLMM adapter |
| `registry.ts` | 10.3KB | Adapter registry |
| `types.ts` | 2.2KB | Adapter type definitions |

**AmmAdapter Interface (from base.ts):**
```typescript
export interface AmmAdapter {
    readonly kind: string;
    readonly poolKind: PoolKind;  // 'cpmm' | 'clmm' | 'hybrid'
    readonly id: string;
    feeBps(): Promise<number>;
    quote(req: QuoteRequest): Promise<QuoteResult>;
    buildSwapIxs(req: SwapIxsRequest): Promise<SwapIxsResult>;
    snapshotTTLms(): number;
}
```

#### packages/risk/src/

| File | Size | Description |
|------|------|-------------|
| `index.ts` | 5.4KB | RiskManager implementation |

**RiskManager Capabilities:**
- Per-minute notional caps (total and per-venue)
- Error burst tracking and soft-blocking
- Rolling window counters with minute-key rotation
- `canProceed()` check before execution
- Environment variable configuration

**RiskCaps Structure:**
```typescript
export type RiskCaps = {
    perMinNotionalQuote: number;
    perVenueNotionalQuote: number;
    errorBurstMax: number;
};
```

#### packages/jito/src/

| File | Size | Description |
|------|------|-------------|
| `tip.ts` | 361B | Tip calculation formula |

**Tip Calculation Formula:**
```typescript
function computeTipLamports(evAbsUsd: number, slotLoad: number, cfg: any): number {
    const { alpha, beta, gamma, maxPct, maxLamports, usdPerLamport } = cfg;
    const share = alpha * evAbsUsd;
    let lam = (share / usdPerLamport) + beta * slotLoad + gamma;
    lam = Math.max(cfg.floor, Math.min(lam, maxLamports));
    return Math.floor(lam);
}
```

#### packages/router/src/

| File | Size | Description |
|------|------|-------------|
| `router.ts` | 2.5KB | Path building logic |
| `types.ts` | 618B | Router type definitions |

**Routing Capabilities:**
- AMM ↔ Phoenix path enumeration
- AMM ↔ AMM path enumeration
- Async adapter factory support

#### packages/executor/src/

| File | Size | Description |
|------|------|-------------|
| `funding.ts` | 923B | Funding management |
| `rpcSim.ts` | 1.3KB | RPC simulation |
| `runner.ts` | 2.5KB | Execution runner |
| `joiners/single_tx.ts` | 1.5KB | Single TX joiner |

**Single TX Joiner Pattern:**
- Combines multiple legs into atomic transaction
- Adds ComputeBudget instructions
- Quote computation for each leg

#### packages/phoenix/src/

| File | Size | Description |
|------|------|-------------|
| `index.ts` | 22.9KB | Phoenix CLOB integration |
| `atomic.ts` | 5.1KB | Atomic execution |
| `diag.ts` | 5.1KB | Diagnostics |
| `l2-cli.ts` | 3.1KB | L2 orderbook CLI |

#### services/arb-mm/src/

| File | Size | Description |
|------|------|-------------|
| `main.ts` | 52.9KB | Main orchestration |
| `multipair.ts` | 31.2KB | Multi-pair arbitrage |
| `replay.ts` | 22KB | Replay system |
| `config.ts` | 16.6KB | Configuration |
| `risk.ts` | 5.9KB | Service-level risk |
| `health.ts` | 1.2KB | Health endpoint |
| `ml_logger.ts` | 8.7KB | ML event logging |
| `ml_events.ts` | 4KB | ML event types |
| `ml_schema.ts` | 3.1KB | ML schema |
| `session_recorder.ts` | 4.4KB | Session recording |
| `rpc_sim.ts` | 3.1KB | RPC simulation |

**Directory Structure:**
- `adapters/` - Service-specific adapters
- `edge/` - Edge case handling
- `execute/` - Execution logic
- `executor/` - Executor implementation
- `infra/` - Infrastructure
- `io/` - I/O utilities
- `market/` - Market data
- `price/` - Price handling
- `provider/` - Data providers
- `publishers/` - Event publishers
- `registry/` - Registry management
- `routing/` - Routing logic
- `rpc/` - RPC handling
- `runtime/` - Runtime utilities
- `submit/` - Submission logic
- `tx/` - Transaction handling
- `types/` - Type definitions
- `util/` - Utilities

### Dependencies (from root package.json)

```json
{
    "@ellipsis-labs/phoenix-sdk": "^2.0.3",
    "@meteora-ag/dlmm": "^1.7.5",
    "@orca-so/common-sdk": "^0.6.11",
    "@orca-so/whirlpools-client": "^4.0.0",
    "@orca-so/whirlpools-sdk": "^0.15.0",
    "@raydium-io/raydium-sdk": "1.3.1-beta.58",
    "@solana/spl-token": "^0.4.13",
    "@solana/web3.js": "^1.98.4"
}
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Run all services concurrently |
| `pnpm dev:phoenix` | Run Phoenix service |
| `pnpm dev:amms` | Run AMMs service |
| `pnpm dev:arb` | Run arb-mm service |
| `pnpm live` | One-button live session |
| `pnpm live:jito` | Live session with Jito mode |
| `pnpm backtest` | Run backtest |
| `pnpm backtest:yday` | Backtest yesterday's data |
| `pnpm report:yday` | Generate daily report |
| `pnpm optimize:yday` | Optimize parameters |

### Venue Coverage

| Venue | Package Location | Status |
|-------|------------------|--------|
| Orca Whirlpool | `packages/amms/src/adapters/orca.ts` | Implemented |
| Raydium CPMM | `packages/amms/src/adapters/raydium.ts` | Implemented |
| Raydium CLMM | `packages/amms/src/adapters/raydium_clmm.ts` | Implemented |
| Phoenix CLOB | `packages/phoenix/src/` | Implemented |

### Strategy Focus

The repository implements AMM ↔ Phoenix CLOB arbitrage, exploiting price discrepancies between orderbook and AMM venues.

### Configuration Files

| File | Purpose |
|------|---------|
| `.env` | Default environment |
| `.env.live` | Live trading environment |
| `.env.shadow` | Shadow mode environment |
| `.env.staging` | Staging environment |
| `services/arb-mm/.env` | Service-specific config |
| `services/arb-mm/configs/` | Additional configs |

### Test Infrastructure

- Test runner: vitest
- Test location: `services/arb-mm/test/`

---

## Appendix F: Cross-Repository Simulation Implementation Reference

This appendix documents simulation math implementations across three local repositories and one GitHub repository. This reference enables cross-validation of simulation accuracy by comparing formula implementations.

### Repository Overview

| Repository | Location | Purpose |
|------------|----------|---------|
| **yogurt** | `/home/dudesoup/code/yogurtslinger_bot/red/yogurt/` | Current project (validation target) |
| **red** | `/home/dudesoup/code/yogurtslinger_bot/red/` | Regression harness + venue-specific simulators |
| **yogurt_bot** | `/home/dudesoup/code/yogurtslinger_bot/` | Alternative simulation + accuracy tracking |
| **DewdSoup/mev** | GitHub: `DewdSoup/mev` | High-precision Decimal.js + SDK-based quoters |

---

### Yogurt (Current Project) - `src/sim/math/`

#### constantProduct.ts
**Purpose:** CPMM simulation for PumpSwap and RaydiumV4

**Key Formulas:**
```typescript
// Output amount with fee applied to input
// dy = (y * dx_after_fee) / (x + dx_after_fee)
export function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
    const amountInWithFee = amountIn * (10000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    return numerator / denominator;
}
```

**Default Fees:**
- PumpSwap: LP 20 bps + Protocol 5 bps = 25 bps
- RaydiumV4: Pool-specific (swapFeeNumerator/swapFeeDenominator)

#### clmm.ts
**Purpose:** Raydium CLMM tick traversal simulation

**Key Formulas:**
```typescript
// Tick to sqrt price (Q64 format)
// sqrtPrice = 1.0001^(tick/2) * 2^64
export function tickToSqrtPriceX64(tick: number): bigint

// Amount deltas
export function getAmount0Delta(sqrtPriceLower, sqrtPriceUpper, liquidity, roundUp): bigint
export function getAmount1Delta(sqrtPriceLower, sqrtPriceUpper, liquidity, roundUp): bigint

// Swap step computation
export function computeSwapStep(sqrtPriceCurrent, sqrtPriceTarget, liquidity, amountRemaining, feeRate, exactInput)
```

**Constants:**
- Q64 = 2^64
- MIN_TICK = -443636
- MAX_TICK = 443636
- TICK_ARRAY_SIZE = 60

#### dlmm.ts
**Purpose:** Meteora DLMM bin traversal simulation

**Key Formulas:**
```typescript
// Bin price calculation
// price = (1 + binStep/10000)^binId
export function getPriceFromBinId(binId: number, binStep: number): bigint

// Fixed-point exponentiation by squaring
function powQ64(baseQ64: bigint, exp: number): bigint

// Single bin swap
export function swapInBin(bin, inputAmount, swapForY, binPriceX64)
```

**Constants:**
- SCALE = 2^64
- BINS_PER_ARRAY = 70

---

### Red Repository - `src/sim/`

#### pumpswapSim.ts
**Purpose:** PumpSwap constant product simulation with fee analysis

**Key Findings from Regression:**
- Fee applied on OUTPUT, not input
- Total fee: 25 bps (LP 20 + Protocol 5)
- Both SELL (baseToQuote) and BUY (quoteToBase) use same 25 bps
- Uses floor rounding for fee deduction

```typescript
export function simulatePumpSwapSwap({ amountIn, baseReserve, quoteReserve, side, feesBps }) {
    // Gross output using constant product
    const grossOut = side === "baseToQuote"
        ? (quoteReserve * amountIn) / (baseReserve + amountIn)
        : (baseReserve * amountIn) / (quoteReserve + amountIn);

    // Fee applied to output (floor)
    const totalFeeBps = feesBps.lpFeeBps + feesBps.protocolFeeBps + feesBps.coinCreatorFeeBps;
    const amountOut = grossOut - (grossOut * totalFeeBps / 10000n);
    return { amountOut };
}
```

#### raydiumV4Sim.ts
**Purpose:** RaydiumV4 constant product with OpenOrders adjustment

**Key Pattern:**
- Reserves adjusted for OpenOrders balances
- PnL adjustments (baseNeedTakePnl, quoteNeedTakePnl) subtracted from vault balances

```typescript
export function simulateRaydiumV4Swap({ pool, amountIn, baseToQuote, baseVaultBalance, quoteVaultBalance, openOrdersBaseTotal, openOrdersQuoteTotal }) {
    // Adjust reserves
    const baseReserve = baseVaultBalance + openOrdersBaseTotal - pool.baseNeedTakePnl;
    const quoteReserve = quoteVaultBalance + openOrdersQuoteTotal - pool.quoteNeedTakePnl;
    // ... constant product math
}
```

#### raydiumCLMMSim.ts
**Purpose:** Full CLMM tick traversal with AmmConfig fee injection

**Key Pattern:**
- AmmConfig account fetched separately (read-only, not streamed)
- tradeFeeRate from AmmConfig, not pool state
- Tick arrays fetched via PDA derivation

```typescript
export function simulateRaydiumCLMMSwapExactIn(pool, cfg, tickArrays, amountIn, zeroForOne) {
    const feeRate = cfg.tradeFeeRate; // From AmmConfig account
    // ... tick traversal with liquidity crossing
}
```

#### meteoraDLMMSim.ts
**Purpose:** DLMM bin traversal with dynamic fee

**Key Pattern:**
- Bin arrays built from multiple BinArray accounts
- Dynamic fee from baseFactor * binStep + volatility component
- Bin traversal direction: swapForY moves toward lower bins

```typescript
export function simulateMeteoraDlmmSwap({ lbPair, bins, direction, amountIn }) {
    // Build bin liquidity map
    // Traverse bins in direction
    // Apply dynamic fee
}
```

---

### Red Repository - `src/regression/runCanonicalRegression.ts`

**Purpose:** Comprehensive regression harness for multi-venue simulation validation

**CanonicalSwapCase Format:**
```typescript
interface CanonicalSwapCase {
    signature: string;
    slot: number;
    venue: "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm";
    tx: { err: boolean | null };
    preAccounts: Record<string, {
        dataBase64: string;
        owner: string;
        lamports: string;
        executable: boolean;
        rentEpoch: string;
    }>;
    tokenBalances: Record<string, {
        preAmount: string;
        postAmount: string;
    }>;
}
```

**Validation Pattern:**
1. Build InMemoryAccountStore from preAccounts
2. Decode pool state from store
3. Extract tokenDelta from tokenBalances (actual output)
4. Run simulator against reconstructed state
5. Compare: `absDiff(simOut, actualOut) <= 1n` (atomic precision)

---

### Yogurt_bot Repository - `src/simulation/`

#### localSimulator.ts
**Purpose:** Zero-latency arbitrage simulation with multi-venue support

**Key Formulas:**
```typescript
// CPMM (matches yogurt)
export function simulateCPMMSwap(amountIn, reserveIn, reserveOut, feeRate) {
    const amountInAfterFee = amountIn * (FEE_DENOMINATOR - feeNumerator) / FEE_DENOMINATOR;
    const amountOut = (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
    return { amountOut, fee, priceImpactBps, effectivePrice };
}

// CLMM single-tick approximation
export function simulateCLMMSwapSingleTick(amountIn, sqrtPriceX64, liquidity, decimals0, decimals1, feeRate, zeroForOne)

// DLMM with bin traversal
export function simulateDLMMSwap(amountIn, activeId, binStep, bins, feeRate, swapForY)
```

**Confidence Levels:**
- CPMM: 0.99 (exact math)
- CLMM: 0.90 (tick complexity)
- DLMM: 0.92 (bin complexity)
- Mixed venues: 0.85

#### simAccuracyTracker.ts
**Purpose:** Real-time accuracy tracking for production monitoring

**Key Features:**
- `recordPrediction()`: Log sim prediction before execution
- `recordActual()`: Log actual result after execution
- Error metrics: profitErrorBps, tokensErrorPercent, solErrorPercent
- Grouping: by venue pair, by confidence bucket
- Rolling window: 1 hour retention, max 10000 records

**Report Output:**
```
PROFIT ACCURACY:
  Average error:       X.X bps
  Within ±5 bps:       XX.X%
  Within ±10 bps:      XX.X%

BY VENUE PAIR:
  PumpSwap→PumpSwap    n=XXX | err=X.X bps | success=XX%
```

---

### DewdSoup/mev Repository (GitHub MCP Access)

**Access:** Use `mcp__github__get_file_contents` with `owner: "DewdSoup"`, `repo: "mev"`

#### packages/amms/src/adapters/base.ts
**AmmAdapter Interface:**
```typescript
export interface AmmAdapter {
    readonly kind: string;
    readonly poolKind: PoolKind;  // 'cpmm' | 'clmm' | 'hybrid'
    readonly id: string;
    feeBps(): Promise<number>;
    quote(req: QuoteRequest): Promise<QuoteResult>;
    buildSwapIxs(req: SwapIxsRequest): Promise<SwapIxsResult>;
    snapshotTTLms(): number;
}
```

#### services/arb-mm/src/util/cpmm.ts
**High-Precision CPMM (Decimal.js):**
```typescript
// 40-digit precision for large reserves
const DECIMAL_PLACES = 40;

export function cpmmSellQuotePerBase(base, quote, sellBase, feeBps) {
    const x = toDecimal(base);
    const y = toDecimal(quote);
    const dx = toDecimal(sellBase);

    const fee = new Decimal(Math.max(0, feeBps)).div(10_000);
    const oneMinusFee = ONE.minus(fee);

    const dxPrime = dx.mul(oneMinusFee);
    const denominator = x.plus(dxPrime);
    const dy = y.mul(dxPrime).div(denominator);

    return dy.isFinite() && dy.gt(0) ? dy.div(dx).toNumber() : undefined;
}
```

**Trade-offs:**
- Higher precision but slower execution
- Useful for extreme reserve ratios (1:1,000,000+)
- Consider for edge case validation

#### services/arb-mm/src/edge/clmm_quoter.ts
**SDK-Based CLMM Quoter:**
- Uses `@raydium-io/raydium-sdk` `Clmm.computeAmountOut/In`
- Handles tick array caching (3s TTL)
- Supports Token-2022 extensions
- Rate limiting with exponential backoff

---

### Formula Comparison Matrix

| Component | Yogurt | Red | Yogurt_bot | mev |
|-----------|--------|-----|------------|-----|
| **CPMM Math** | BigInt | BigInt | BigInt | Decimal.js (40-digit) |
| **PumpSwap Fee** | Pre-swap (⚠️ incorrect for SELL) | Direction-dependent: SELL=post-output, BUY=pre-input | Pre-swap | Pre-swap |
| **RaydiumV4 Fee** | Pre-swap | Pre-swap (with OpenOrders adjust) | Pre-swap | Pre-swap |
| **CLMM Approach** | Full traversal | Full traversal | Single-tick approx | SDK-based |
| **DLMM Approach** | Full traversal | Full traversal | Full traversal | N/A |
| **Tick Constants** | MIN=-443636 | Same | Same | SDK defaults |
| **Q64 Format** | 2^64 | 2^64 | 2^64 | SDK |

**⚠️ CRITICAL:** Yogurt's `constantProduct.ts` applies fee pre-swap for all directions. For PumpSwap SELL, this is incorrect - on-chain applies fee to output (post-swap).

### Critical Validation Points

1. **PumpSwap Fee Placement:** Red regression proves fee is on OUTPUT, not input
2. **CLMM AmmConfig:** Fee rate comes from separate AmmConfig account, not pool state
3. **DLMM Bin Direction:** swapForY traverses toward lower bins (decrementing binId)
4. **RaydiumV4 OpenOrders:** Must adjust reserves for OpenOrders and PnL
5. **Precision Edge Cases:** Test extreme reserve ratios with Decimal.js comparison

### Access Instructions

**Local Repositories:**
```bash
# Red simulation files
cat ../src/sim/pumpswapSim.ts
cat ../src/sim/raydiumV4Sim.ts
cat ../src/sim/raydiumCLMMSim.ts
cat ../src/sim/meteoraDLMMSim.ts

# Red regression harness
cat ../src/regression/runCanonicalRegression.ts

# Yogurt_bot simulation
cat ../../../src/simulation/localSimulator.ts
cat ../../../src/simulation/simAccuracyTracker.ts
```

**GitHub MCP Access:**
```typescript
// Fetch mev CPMM implementation
mcp__github__get_file_contents({
    owner: "DewdSoup",
    repo: "mev",
    path: "services/arb-mm/src/util/cpmm.ts"
})

// Fetch mev CLMM quoter
mcp__github__get_file_contents({
    owner: "DewdSoup",
    repo: "mev",
    path: "services/arb-mm/src/edge/clmm_quoter.ts"
})
```

---

## Subagent Review Prompt

You are a senior Solana MEV engineer and systems architect.

Review the attached sprint plan as if you are preparing it for an execution team to implement.

Focus on:
1) Highest-ROI sequencing: what should be pulled earlier/later for fastest safe profitability?
2) Correctness risks: anything that can silently produce incorrect deltas, incorrect simulations, or failed bundles.
3) Latency risks: anything likely to blow p99 budgets in the hot path.
4) Missing tickets: anything required for a true end-to-end go-live that is not explicitly ticketed.
5) Test strategy: are unit/integration/replay tests sufficient and practical?
6) Operational readiness: observability, kill-switches, safe modes, and runbook completeness.

Output format:
- “Top 10 improvements” list with rationale
- “Critical blockers” (must-fix before go-live)
- “Nice-to-haves” (post-go-live)

Do not rewrite the whole plan; propose targeted improvements and where they belong.

## Subagent Suggested Improvements (Simulated)

### Top 10 improvements
1) **Unify CPMM math used by simulation and speculative overlay** to avoid drift (single source of truth; one set of rounding rules).
2) **Store vault pubkeys on SwapLeg wherever possible** (RaydiumV4 swap accounts include vaults) so overlay never blocks on pool-state lookups.
3) Add an explicit **overlay feature flag + safe fallback**: speculative on/off without redeploy.
4) Add **microbench/perf regression tests** for overlay replay and opportunity sizing.
5) Ensure **raw signed tx bytes** are always captured for victims (bundle inclusion requires full tx bytes, not message bytes).
6) Add **bounded memory guarantees** for per-slot order map, per-pool ops lists, and any signature→pool index.
7) Add a **debug-dump tooling path** (pool overlay dump, per-op replay trace) gated by config for production triage.
8) Add **shadow mode** in the execution pipeline: detect + simulate + build bundles but do not submit, while recording what would have been sent.
9) Add an **“invariant / sanity” guardrail**: e.g., reserve deltas must keep reserves non-negative; reject if not.
10) Add **evidence-driven validation** specifically for exact-out semantics (PumpSwap buy, RaydiumV4 swapBaseOut).

### Critical blockers (pre-go-live)
- Missing raw tx bytes in pending stream path breaks bundling.
- Overlay must be order-aware for same-pool multi-pending, otherwise sizing and profit can be systematically wrong.
- Vault pubkeys missing on RaydiumV4 legs will cause cache lookups/misses and degrade latency and correctness.

### Nice-to-haves (post-go-live)
- Worker-thread pool for parallel sizing / route search.
- Tip/priority-fee optimizer from bundle landing telemetry.
- Expanded venue support and multi-leg route simulation.

## Improvements Incorporated

The following improvements have been incorporated into this plan:
- **Single source-of-truth math path**: CPMM overlay uses `cpmmApply.ts`, and Sprint 1 validation gates rounding/fee placement; simulation may be refactored to call the same functions.
- **Vault pubkeys on legs**: Sprint 4.5 explicitly requires `baseVault/quoteVault` to be populated for RaydiumV4 from swap accounts.
- **Feature flags & bounds**: Sprint 0 adds `enableSpeculativeOverlay`, pending expiration and sizing bounds.
- **Raw tx bytes + order keys**: Sprint 4.5 adds signed-tx parsing utilities, ShredStream wiring for `rawTx`, and evidence capture schema to persist it.
- **Observability + demo tooling**: Sprint 4.5 adds overlay metrics, debug dumps, and a `pnpm demo:speculative` live demo script.

Remaining suggestions are already covered elsewhere in the plan (dry-run mode, circuit breaker, replay validation) or are intentionally deferred to post-go-live optimization work.
