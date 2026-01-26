# Quoter Implementation Analysis Report

## Executive Summary

This report analyzes the quoter implementations from `DewdSoup/mev` repository and compares them against yogurt's simulation needs. The mev repo uses a **SDK-based quoting approach** with aggressive caching and rate limiting strategies designed for high-frequency MEV operations.

---

## 1. DewdSoup/mev Quoter Architecture Overview

### 1.1 File Inventory

| File | Purpose |
|------|---------|
| `clmm_quoter.ts` | CLMM quoting for Raydium CLMM and Orca Whirlpools |
| `dlmm_quoter.ts` | DLMM quoting for Meteora |
| `amm_quote.ts` | CPMM exact-in quoting (pure math, no SDK) |
| `joiner.ts` | Multi-venue route evaluation and orchestration |
| `util/cpmm.ts` | High-precision Decimal.js CPMM math |
| `util/meteora_dlmm.ts` | Meteora DLMM instance management and bin array caching |

### 1.2 Quoting Strategy Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                        joiner.ts                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  1. Adapter Quote (config-driven, fee/slippage aware)    │   │
│  │  2. Local CPMM (reserves-based, Decimal.js precision)    │   │
│  │  3. SDK Fallback (Raydium SDK, Orca SDK)                 │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. SDK-Based Quoting Approach

### 2.1 Raydium CLMM (via Raydium SDK)

**Key Dependencies:**
```typescript
import { Clmm, fetchMultipleMintInfos, type ClmmPoolInfo } from "@raydium-io/raydium-sdk";
```

**Quote Flow:**
1. Fetch pool info via `Clmm.fetchMultiplePoolInfos()`
2. Fetch tick arrays via `Clmm.fetchMultiplePoolTickArrays()`
3. Resolve Token-2022 mint info if applicable
4. Call `Clmm.computeAmountOut()` for SELL or `Clmm.computeAmountIn()` for BUY
5. Extract fee from `tradeFeeRate` in `AmmConfig`

**Critical Finding - AmmConfig:**
```typescript
// AmmConfig accounts are READ-ONLY and NOT streamed via gRPC
// Fee rate comes from AmmConfig, not pool state
const feeFallbackBps = fallbackFeeBpsFromTradeRate(poolInfo.ammConfig?.tradeFeeRate);
```

### 2.2 Orca Whirlpools (via Orca SDK)

**Key Dependencies:**
```typescript
import { WhirlpoolContext, buildWhirlpoolClient, swapQuoteByInputToken, swapQuoteByOutputToken } from "@orca-so/whirlpools-sdk";
```

**Quote Flow:**
1. Build WhirlpoolContext with AnchorProvider
2. Get pool via `client.getPool()`
3. Call `swapQuoteByInputToken()` for SELL or `swapQuoteByOutputToken()` for BUY
4. Use `UseFallbackTickArray.Situational` for tick array handling

**Absurd Impact Guard:**
```typescript
const ORCA_ABSURD_IMPACT_BPS = Number(process.env.ORCA_ABSURD_IMPACT_BPS ?? 100_000);
// Reject quotes with price impact > 1000% as "missing_tick_array"
```

### 2.3 Meteora DLMM (via Meteora SDK)

**Key Dependencies:**
```typescript
import MeteoraPkg from "@meteora-ag/dlmm";
```

**Quote Flow:**
1. Create DLMM instance via `DLMM.create()`
2. Fetch bin arrays via `getBinArrayForSwap(swapForY, horizon)`
3. Call `dlmm.swapQuote()` for SELL or `dlmm.swapQuoteExactOut()` for BUY

---

## 3. Cache TTL Patterns

### 3.1 CLMM Caching (Raydium)

| Cache | TTL | Environment Variable |
|-------|-----|---------------------|
| API Pool List | 60s | `RAYDIUM_CLMM_API_TTL_MS` |
| Pool Info | 5s | `RAYDIUM_CLMM_POOLINFO_TTL_MS` |
| **Tick Arrays** | **3s** | `RAYDIUM_CLMM_TICKARRAY_TTL_MS` |
| Epoch Info | 15s | `CLMM_EPOCH_TTL_MS` |
| Mint Info | 600s (10min) | `CLMM_MINTINFO_TTL_MS` |
| On-Chain Quote | 750ms | `CLMM_ONCHAIN_CACHE_TTL_MS` |

### 3.2 Orca Whirlpool Caching

| Cache | TTL | Environment Variable |
|-------|-----|---------------------|
| Whirlpool Pool | 4s | `ORCA_WHIRLPOOL_TTL_MS` |

### 3.3 Meteora DLMM Caching

| Cache | TTL | Environment Variable |
|-------|-----|---------------------|
| Pool State Refresh | 2s | `DLMM_STATE_REFRESH_MS` |
| Pool State Max Age | 5s | `DLMM_STATE_MAX_AGE_MS` |
| **Bin Array Cache** | **1.5s** | `DLMM_BIN_ARRAY_CACHE_MS` |
| Bin Array Max Age | 7.5s | `DLMM_BIN_ARRAY_MAX_AGE_MS` |
| Mint Decimals | Infinite | (no expiration) |

### 3.4 Key Insight: Tick/Bin Array TTL

**Tick arrays (CLMM) and bin arrays (DLMM) have the shortest TTLs (1.5-3s)** because:
1. Liquidity positions change frequently
2. Stale tick/bin data causes incorrect swap outputs
3. Price impact calculations depend on current liquidity distribution

---

## 4. Rate Limiting and Cooldown Strategies

### 4.1 Exponential Backoff Pattern

```typescript
// CLMM Quoter
const RATE_LIMIT_BASE_MS = Number(process.env.CLMM_RATELIMIT_BASE_MS ?? 500);
const RATE_LIMIT_MAX_MS = Number(process.env.CLMM_RATELIMIT_MAX_MS ?? 5_000);
const RATE_LIMIT_MAX_STRIKES = Number(process.env.CLMM_RATELIMIT_MAX_STRIKES ?? 6);

function computeBackoff(failureCount: number): number {
    const exponent = Math.max(0, failureCount - 1);
    const delay = RATE_LIMIT_BASE_MS * Math.pow(2, exponent);
    return Math.min(delay, RATE_LIMIT_MAX_MS);
}
// 500ms → 1s → 2s → 4s → 5s (capped)
```

### 4.2 Per-Pool Cooldown Tracking

```typescript
type RateLimitState = {
    strikes: number;
    until: number;      // Timestamp when cooldown expires
    logged?: boolean;   // Prevent log spam
};

const rateLimitMap = new Map<string, RateLimitState>();

function shouldSkipForCooldown(key: string): { active: boolean; remaining: number } {
    const remaining = cooldownRemaining(key);
    if (remaining <= 0) return { active: false, remaining: 0 };
    // Log only once per cooldown period
    if (!state.logged) {
        logger.log("clmm_quote_cooldown", { key, wait_ms: remaining, strikes: state.strikes });
        state.logged = true;
    }
    return { active: true, remaining };
}
```

### 4.3 DLMM Failure State per Bin Direction

```typescript
interface BinFailureState {
    failureCount: number;
    cooldownUntil: number;
    lastError?: string;
}

// Key includes swap direction: `${swapForY ? "1" : "0"}:${horizon}`
cache.binFailures: Map<string, BinFailureState>
```

### 4.4 Rate Limit Detection

```typescript
function isRateLimitError(err: any): boolean {
    const msg = String((err?.message ?? err) ?? "").toLowerCase();
    return msg.includes("429") ||
           msg.includes("rate limit") ||
           msg.includes("too many requests");
}
```

---

## 5. Snapshot-Only Mode for Shadow Deployment

### 5.1 Configuration

```typescript
// Enable snapshot-only mode (no per-quote RPC calls)
const SNAPSHOT_ONLY = String(process.env.QUOTER_SNAPSHOT_ONLY ?? "1").trim() === "1";

// Allow on-chain fallback when snapshot data insufficient
const ALLOW_ONCHAIN_FALLBACK = String(process.env.CLMM_ALLOW_ONCHAIN_FALLBACK ?? "1").trim() !== "0";
```

### 5.2 Soft-Block Pattern

```typescript
function snapshotOnlyBlock(venue: string, poolId: string, side: QuoteSide, sizeBase: number) {
    if (!SNAPSHOT_ONLY) return null;
    if (ALLOW_ONCHAIN_FALLBACK) {
        // Log once per pool, then allow
        if (!snapshotAllowLogged.has(key)) {
            snapshotAllowLogged.add(key);
            logger.log("clmm_quote_snapshot_allow", { venue, pool: poolId });
        }
        return null;
    }
    // Hard block - return error, don't throw
    logger.log("clmm_quote_snapshot_only_block", { venue, pool: poolId, side, size_base: sizeBase });
    return { ok: false as const, err: "snapshot_only" };
}
```

### 5.3 Reserve-Based Fallback for CPMM

```typescript
function quoteFromReserves(args: QuoteArgs): QuoteResult | null {
    // CLMM/DLMM pools do NOT use reserve-based quoting
    const kind = String(args.poolKind ?? "").toLowerCase();
    if (kind === "clmm" || kind === "dlmm") return null;

    // For CPMM: use cached reserves
    const reserves = args.reserves;
    if (!reserves) return null;

    const price = args.side === "buy"
        ? cpmmBuyQuotePerBase(base, quote, args.sizeBase, feeBps)
        : cpmmSellQuotePerBase(base, quote, args.sizeBase, feeBps);

    return { ok: true, price, feeBps, meta: { source: "snapshot_cpmm" } };
}
```

---

## 6. Price Impact Calculation

### 6.1 CLMM Price Impact

```typescript
// Computed from execution price vs mid price
const priceImpactBps = (() => {
    const exec = new Decimal(computeOut.executionPrice.toString());
    const mid = baseIsA
        ? new Decimal(poolInfo.currentPrice.toString())
        : new Decimal(1).div(poolInfo.currentPrice.toString());
    return exec.div(mid).minus(1).mul(10_000).toNumber();
})();
```

### 6.2 CPMM Price Impact (amm_quote.ts)

```typescript
export function quoteCpmmExactIn(s: CpmmState, baseIn: boolean, amountInBase: bigint) {
    const x = Number(s.baseReserves);
    const y = Number(s.quoteReserves);
    const dx = Number(amountInBase);
    const dxAfterFee = dx * (1 - s.feeBps / 10_000);

    // Constant product math
    const k = x * y;
    const x1 = x + dxAfterFee;
    const y1 = k / x1;
    const dy = y - y1;

    // Price impact: (effective_price / mid_price - 1) * 10000
    const mid = y / x;
    const eff = dy / dxAfterFee;
    const priceImpactBps = (eff / mid - 1) * 10_000;

    return { ok: true, outAtoms: BigInt(Math.floor(dy)), priceImpactBps, feeBps: s.feeBps };
}
```

---

## 7. High-Precision Math (Decimal.js)

### 7.1 Configuration

```typescript
import Decimal from "decimal.js";
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
```

### 7.2 CPMM with Decimal.js (util/cpmm.ts)

```typescript
export function cpmmBuyQuotePerBase(base: number, quote: number, wantBase: number, feeBps: number) {
    const x = toDecimal(base);
    const y = toDecimal(quote);
    const dx = toDecimal(wantBase);

    const fee = new Decimal(Math.max(0, feeBps)).div(10_000);
    const oneMinusFee = ONE.minus(fee);

    // x * y = k formula with high precision
    const denominator = x.minus(dx);
    const dqPrime = dx.mul(y).div(denominator);
    const dq = dqPrime.div(oneMinusFee);
    const avgQuotePerBase = dq.div(dx);

    return avgQuotePerBase.toNumber();
}
```

**Why 40-digit precision matters:**
- Extreme reserve ratios (1:1,000,000) with small amounts
- Prevents precision drift in multi-hop simulations
- Critical for MEV where 1 bps matters

---

## 8. Recommendations for Yogurt

### 8.1 Architecture Alignment

| Yogurt Current | mev Approach | Recommendation |
|----------------|--------------|----------------|
| Pure BigInt math | Decimal.js 40-digit | **Evaluate for CPMM** (S1-T13) |
| Native tick traversal | SDK-based quoting | **Keep native** (more control) |
| gRPC cache as truth | Snapshot + RPC fallback | **Keep gRPC** (lower latency) |
| Delta summation | Order-aware replay | **Adopt replay** (S4.5 planned) |

### 8.2 Cache TTL Adoption

```typescript
// Recommended yogurt cache TTLs (aligned with mev patterns)
export const CACHE_TTL = {
    // CLMM
    TICK_ARRAY_MS: 3_000,      // Critical - short TTL
    POOL_INFO_MS: 5_000,
    AMM_CONFIG_MS: 300_000,    // 5 min - rarely changes

    // DLMM
    BIN_ARRAY_MS: 1_500,       // Critical - short TTL
    POOL_STATE_MS: 2_000,

    // CPMM
    VAULT_BALANCE_MS: 1_000,   // Via gRPC, not RPC

    // Shared
    MINT_DECIMALS_MS: Infinity,
    EPOCH_INFO_MS: 15_000,
};
```

### 8.3 Rate Limiting Implementation

```typescript
// Recommended pattern for yogurt
interface PoolCooldown {
    failureCount: number;
    cooldownUntil: number;
    lastError?: string;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;
const MAX_STRIKES = 6;

function computeBackoff(failures: number): number {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, failures - 1)));
}
```

### 8.4 Snapshot-Only Mode for Shadow Deployment

Yogurt should implement a shadow mode where:
1. All simulation runs against local cache only
2. No RPC calls during quote path
3. Logging captures predicted vs actual for validation
4. Configurable via `YOGURT_SHADOW_MODE=1`

```typescript
// Yogurt config addition (src/config.ts)
export const QUOTER_CONFIG = {
    shadowMode: process.env.YOGURT_SHADOW_MODE === "1",
    allowRpcFallback: process.env.ALLOW_RPC_FALLBACK !== "0",
    logMissingData: process.env.LOG_MISSING_QUOTE_DATA === "1",
};
```

### 8.5 CLMM AmmConfig Handling

**Critical for S1-T10:** AmmConfig accounts contain the fee rate and are not streamed via gRPC. Yogurt needs:

```typescript
// src/topology/ammConfig.ts
const ammConfigCache = new Map<string, { tradeFeeRate: bigint; fetchedAt: number }>();
const AMM_CONFIG_TTL_MS = 300_000; // 5 minutes

export async function getAmmConfigFee(configPubkey: Uint8Array): Promise<bigint> {
    const key = toHex(configPubkey);
    const cached = ammConfigCache.get(key);
    const now = Date.now();

    if (cached && now - cached.fetchedAt < AMM_CONFIG_TTL_MS) {
        return cached.tradeFeeRate;
    }

    // RPC fetch (one-time per config, rarely changes)
    const account = await fetchAccountInfo(configPubkey);
    const tradeFeeRate = decodeAmmConfigTradeFeeRate(account.data);

    ammConfigCache.set(key, { tradeFeeRate, fetchedAt: now });
    return tradeFeeRate;
}
```

### 8.6 Speculative Overlay Upgrade (S4.5)

The mev repo does NOT implement order-aware replay - it uses snapshot-based quoting. Yogurt's S4.5 speculative overlay is more sophisticated:

**Yogurt's planned approach (correct for CPMM):**
```
Confirmed Cache + Ordered Pending Replay = Speculative Reserves
```

**Key insight from mev codebase:** The joiner evaluates routes using the *most recent* AMM snapshot, not speculative state. For MEV, yogurt's order-aware replay is the correct approach because:
1. CPMM output depends on execution order
2. Multiple pending swaps to same pool cannot be summed
3. Speculative reserves must reflect sequential application

### 8.7 Fee Structure Alignment

**PumpSwap (asymmetric - per S1-T9):**
```typescript
// SELL: fee on OUTPUT (post-swap)
// BUY: fee on INPUT (pre-swap)
// mev codebase uses adapter quote which handles this internally
```

**RaydiumV4:**
```typescript
// Fee always on INPUT (pre-swap)
// Pool-specific fee from swapFeeNumerator/swapFeeDenominator
```

**RaydiumClmm:**
```typescript
// Fee from AmmConfig.tradeFeeRate (not pool state!)
// Common tiers: 1, 4, 25, 100 bps
```

**MeteoraDlmm:**
```typescript
// Dynamic fee = (baseFactor * binStep) / 10000 + volatility component
// baseFactor in 1e-10 precision
```

---

## 9. Summary: What Yogurt Should Adopt

### Immediate (S1)
1. **Cache TTLs**: Match tick array (3s) and bin array (1.5s) patterns
2. **AmmConfig fetcher**: Implement for CLMM fee rate resolution
3. **Rate limit detection**: Add `isRateLimitError()` helper
4. **Precision evaluation**: Test Decimal.js vs BigInt for edge cases (S1-T13)

### Short-Term (S4.5)
1. **Keep order-aware replay**: Superior to mev's snapshot-only approach
2. **Add snapshot-only mode**: For shadow deployment validation
3. **Implement cooldown tracking**: Per-pool exponential backoff

### Long-Term (S5+)
1. **Adapter abstraction**: Config-driven venue quoters (like mev's joiner)
2. **Multi-venue route evaluation**: Graph-based path enumeration
3. **Price impact guards**: Reject absurd quotes (>100% impact)

---

## Appendix: Environment Variable Reference

### CLMM Quoter
```bash
RAYDIUM_CLMM_API_TTL_MS=60000
RAYDIUM_CLMM_POOLINFO_TTL_MS=5000
RAYDIUM_CLMM_TICKARRAY_TTL_MS=3000
CLMM_EPOCH_TTL_MS=15000
CLMM_MINTINFO_TTL_MS=600000
CLMM_ONCHAIN_CACHE_TTL_MS=750
CLMM_RATELIMIT_BASE_MS=500
CLMM_RATELIMIT_MAX_MS=5000
CLMM_RATELIMIT_MAX_STRIKES=6
QUOTER_SNAPSHOT_ONLY=1
CLMM_ALLOW_ONCHAIN_FALLBACK=1
ORCA_ABSURD_IMPACT_BPS=100000
```

### DLMM Quoter
```bash
DLMM_STATE_REFRESH_MS=2000
DLMM_STATE_MAX_AGE_MS=5000
DLMM_BIN_ARRAY_HORIZON=4
DLMM_BIN_ARRAY_CACHE_MS=1500
DLMM_BIN_ARRAY_MAX_AGE_MS=7500
DLMM_MIN_SLIPPAGE_BPS=1
DLMM_BACKOFF_BASE_MS=500
DLMM_BACKOFF_MAX_MS=10000
DLMM_ERROR_LOG_THROTTLE_MS=2000
```

---

*Generated: 2026-01-21*
*Source: DewdSoup/mev repository analysis*
