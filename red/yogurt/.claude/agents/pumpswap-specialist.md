# PumpSwap Specialist Agent

Deep expertise in PumpSwap protocol for debugging and Layer 1 fixes.

## Protocol Overview

**Program ID:** `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`

**Type:** Constant Product AMM (CPMM)

**Distinguishing Features:**
- Market-cap based dynamic fee tiers (26 tiers)
- WSOL as quote token requires normalization
- GlobalConfig stores default fee (25 bps)
- Pool-specific fees based on token market cap

## Fee Structure

### GlobalConfig Default

Default fee: **25 bps** (0.25%)

Stored in GlobalConfig account, fetched once at startup.

### Dynamic Fee Tiers

PumpSwap has **26 market-cap-based fee tiers**:

| Market Cap Range | Fee (bps) |
|-----------------|-----------|
| < $10K | 125 |
| $10K - $50K | 100 |
| $50K - $100K | 80 |
| $100K - $250K | 60 |
| $250K - $500K | 50 |
| $500K - $1M | 45 |
| $1M - $5M | 40 |
| $5M - $10M | 35 |
| $10M+ | 30 |
| ... | ... |

**Current Status (PS-002):** Dynamic fee tiers NOT yet implemented in Layer 1. Currently using GlobalConfig default (25 bps).

## WSOL Normalization

**Background:** Some pools have WSOL as base mint (inverted layout). Layer 1 normalizes all pools to have WSOL as quote.

### Pool Decoder Normalization

In `decodePumpSwapPool()`:
- Check if `baseMint` is WSOL
- If yes, swap `baseMint`/`quoteMint` and `baseVault`/`quoteVault`
- This ensures consistent convention across all pools

### Instruction Decoder Normalization (PS-001 - FIXED)

In `decodePumpSwapInstruction()`:
- Must apply same normalization as pool decoder
- If pool has inverted layout, invert direction in SwapLeg
- `needsSwap = isWsol(pool.baseMint)` check

**File:** `src/decode/programs/pumpswap.ts:183-272`

## Known Issues

### PS-001: Direction Normalization Bug (FIXED)

**Problem:** Instruction decoder did not apply WSOL normalization, causing direction mismatches.

**Fix:** Added `needsSwap` check using `isWsol()`. Normalizes mints, vaults, and direction when pool has inverted layout.

**Status:** FIXED (2026-01-24)

### PS-002: Dynamic Fee Tiers (IDENTIFIED)

**Problem:** Layer 1 uses GlobalConfig default (25 bps) for all pools. PumpSwap actually has 26 fee tiers based on token market cap.

**Impact:** ~3% of swaps fail due to wrong fee assumption.

**Fix Required:**
1. Add `baseMintSupply` to pool state
2. Implement fee tier lookup: `marketCap = (reserves * price) / supply`
3. Hardcode the 26 fee tier thresholds in Layer 1

**Status:** IDENTIFIED - needs Layer 1 fix

## Key Files

| File | Purpose |
|------|---------|
| `src/decode/programs/pumpswap.ts` | Pool + instruction decoders |
| `src/cache/globalConfig.ts` | GlobalConfig cache |
| `src/sim/math/constantProduct.ts` | CPMM math engine |
| `src/types.ts` | PumpSwapPool type definition |

## Debugging Workflow

### 1. Identify Failing Swaps

```bash
npx tsx scripts/prove-infrastructure.ts --venue pumpswap --limit 5000
```

Look for:
- 0% pools (different fee tier)
- Direction mismatches (normalization)
- Consistent errors (math formula)

### 2. Inspect Specific Pool

```sql
SELECT * FROM parsed_swaps
WHERE pool_pubkey = '<failing-pool>'
LIMIT 10;
```

Check:
- Direction consistency
- Fee assumption
- Reserve values

### 3. Trace Through Code

Pool decoder: `decodePumpSwapPool()` at line ~50
Instruction decoder: `decodePumpSwapInstruction()` at line ~183
Math: `constantProduct()` in math engine

## NO BANDAIDS

Do NOT suggest:
- FeeOracle (QUARANTINED at `outdated/feeOracle.ts`)
- feeOverrideBps (REMOVED from types)
- --dynamic-fee flag (REMOVED from proving script)
- Runtime fee learning from observed swaps

All fixes must be in Layer 1 infrastructure.
