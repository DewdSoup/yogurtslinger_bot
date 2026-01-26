# Decoder Comparison Report: Yogurt vs Red

## Executive Summary

This report compares the decoder implementations between the `yogurt` codebase (in `/red/yogurt/src/decode/programs/`) and the reference `red` decoders (in `/red/src/decoders/`). Both codebases target the same four Solana DEX venues:

| Venue | Program ID | Math Model |
|-------|------------|------------|
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | Constant Product (x*y=k) |
| Raydium V4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Constant Product |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Concentrated Liquidity |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Discretized Liquidity |

---

## 1. PumpSwap Decoder Comparison

### Pool Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | `pumpswap.ts` | `pumpswapPool.ts` |
| Discriminator | `f19a6d0411b16dbc` (bytes) | `f19a6d0411b16dbc` (Buffer) |
| Min Size | 211 bytes | 211 bytes |
| Match | **EXACT** | |

**Layout (Both implementations agree):**
```
Offset    Field
------    -----
0..8      discriminator
8         poolBump (u8)
9..11     index (u16)
11..43    creator (pubkey)
43..75    baseMint (pubkey)
75..107   quoteMint (pubkey)
107..139  lpMint (pubkey)
139..171  poolBaseTokenAccount (base vault)
171..203  poolQuoteTokenAccount (quote vault)
203..211  lpSupply (u64)
```

### GlobalConfig Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| Discriminator | `fa f0 84 4a 9b 66 7c 6e` | `95 08 9c ca a0 fc b0 d9` |
| Min Size | 616 bytes | 321 bytes |
| Offsets | Different | Different |
| Match | **DISCREPANCY** | |

**CRITICAL FINDING:** The GlobalConfig discriminators differ significantly. This suggests:
1. Red's decoder may be targeting a different account type, or
2. The discriminators may have been updated on-chain

**Yogurt GlobalConfig Layout:**
```
Offset    Field
------    -----
8..40     admin
40..48    lpFeeBasisPoints (u64)
48..56    protocolFeeBasisPoints (u64)
56..64    coinCreatorFeeBasisPoints (u64)
64..320   protocolFeeRecipients ([Pubkey; 8])
```

**Red GlobalConfig Layout:**
```
Offset    Field
------    -----
8..40     admin
40..48    lpFeeBasisPoints (u64)
48..56    protocolFeeBasisPoints (u64)
56..57    disableFlags (u8)
57..313   protocolFeeRecipients (8 * 32)
313..321  coinCreatorFeeBasisPoints (u64)
```

### Swap Instruction Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| Buy Discriminator | `66063d1201daebea` | `66063d1201daebea` |
| Sell Discriminator | `33e685a4017f83ad` | (same used) |
| Match | **YOGURT MORE COMPLETE** | |

**Yogurt Advantage:** Separate buy/sell discriminators with distinct direction handling:
- buy: `66063d1201daebea` - user buys base with quote (BtoA)
- sell: `33e685a4017f83ad` - user sells base for quote (AtoB)

**Data Layout (Both agree):**
```
Offset    Field (buy)              Field (sell)
------    -----------              ------------
0..8      discriminator            discriminator
8..16     baseAmountOut (u64)      baseAmountIn (u64)
16..24    maxQuoteAmountIn (u64)   minQuoteAmountOut (u64)
```

### Fee Config (Pump Fees Program)

**Red has additional decoder: `pumpFeesFeeConfig.ts`**

This decoder handles the tiered fee structure from the `pump_fees` program:
- Program: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
- Discriminator: `8f3492bbdb7b4c9b`
- Supports market-cap-based fee tier selection

**GAP IN YOGURT:** Yogurt lacks the tiered fee config decoder. Uses static defaults.

---

## 2. Raydium V4 Decoder Comparison

### Pool Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | `raydiumV4.ts` | `raydiumV4Pool.ts` |
| Size | 752 bytes (exact) | 752 bytes (exact) |
| Match | **EXACT** | |

**Layout (Both implementations agree exactly):**
```
Offset    Field
------    -----
0..8      status (u64)
32..40    baseDecimal (u64)
40..48    quoteDecimal (u64)
176..184  swapFeeNumerator (u64)
184..192  swapFeeDenominator (u64)
192..200  baseNeedTakePnl (u64)
200..208  quoteNeedTakePnl (u64)
224..232  poolOpenTime (u64) [Red only]
336..368  baseVault (pubkey)
368..400  quoteVault (pubkey)
400..432  baseMint (pubkey)
432..464  quoteMint (pubkey)
464..496  lpMint (pubkey)
496..528  openOrders (pubkey)
528..560  marketId (pubkey) [Red only]
560..592  marketProgramId (pubkey) [Red only]
592..624  targetOrders (pubkey)
688..720  owner (pubkey) [Red only]
720..728  lpReserve (u64) [Red only]
```

**Red has additional fields** that Yogurt omits (marketId, marketProgramId, owner, lpReserve, poolOpenTime).

### OpenOrders Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | N/A | `raydiumV4OpenOrders.ts` |
| Size | - | 3228 bytes |
| Match | **GAP IN YOGURT** | |

**Red OpenOrders Layout:**
```
Offset    Field
------    -----
0..5      magic ("serum")
5         version (u8)
13..45    market (pubkey)
45..77    owner (pubkey)
77..85    baseTokenFree (u64)
85..93    baseTokenTotal (u64)
93..101   quoteTokenFree (u64)
101..109  quoteTokenTotal (u64)
```

**GAP IN YOGURT:** Missing OpenOrders decoder needed for accurate V4 reserve calculation.

### Swap Instruction Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| swapBaseIn disc | `9` (single byte) | `9` |
| swapBaseOut disc | `11` (single byte) | `9` (Red uses same) |
| Match | **YOGURT MORE COMPLETE** | |

---

## 3. Raydium CLMM Decoder Comparison

### Pool Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | `raydiumClmm.ts` | `raydiumCLMMPool.ts` |
| Discriminator | `f7ede3f5d7c3de46` | `f7ede3f5d7c3de46` |
| Size | 1544 bytes | 1544 bytes |
| Match | **MINOR DIFFERENCES** | |

**Layout Comparison:**

| Field | Yogurt Offset | Red Offset | Match |
|-------|--------------|------------|-------|
| bump | 8 | 8 | YES |
| ammConfig | 9..41 | 9..41 | YES |
| tokenMint0 | 73..105 | 73..105 | YES |
| tokenMint1 | 105..137 | 105..137 | YES |
| tokenVault0 | 137..169 | 137..169 | YES |
| tokenVault1 | 169..201 | 169..201 | YES |
| mintDecimals0 | 233 | 233 | YES |
| mintDecimals1 | 234 | 234 | YES |
| tickSpacing | 235..237 | 235..237 | YES |
| liquidity | 237..253 | 237..253 | YES |
| sqrtPriceX64 | 253..269 | 253..269 | YES |
| tickCurrent | 269..273 | 269..273 | YES |
| feeGrowthGlobal0X64 | N/A | 277..293 | RED ONLY |
| status | 389 | 389 | YES |
| tickArrayBitmap | 904..1032 | 840..968 | **MISMATCH** |

**CRITICAL FINDING:** Tick array bitmap offset differs:
- Yogurt: 904
- Red: 840

This is a significant discrepancy that needs investigation. Red's offset documentation explicitly notes padding after `tickCurrent`:
```
tickCurrent: i32
padding3: u16
padding4: u16
```

**Red has additional fields:**
- feeGrowthGlobal0X64, feeGrowthGlobal1X64
- protocolFeesToken0, protocolFeesToken1
- swapInAmountToken0, swapOutAmountToken1, etc.
- totalFeesToken0/1, fundFeesToken0/1
- openTime, recentEpoch

### AmmConfig Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | `raydiumClmm.ts` (embedded) | `raydiumAmmConfig.ts` |
| Discriminator | N/A (uses heuristics) | `daf42168cbcb2b6f` |
| Min Size | 100 | 117 |
| tradeFeeRate offset | 47 | 47 |
| tickSpacing offset | 51 | 51 |
| Match | **RED MORE ROBUST** | |

**Red AmmConfig Layout:**
```
Offset    Field
------    -----
8         bump (u8)
9..11     index (u16)
11..43    owner (pubkey)
43..47    protocolFeeRate (u32)
47..51    tradeFeeRate (u32)
51..53    tickSpacing (u16)
53..57    fundFeeRate (u32)
57..89    fundOwner (pubkey)
```

### TickArray Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | `tickArray.ts` | `raydiumTickArray.ts` |
| Discriminator | `c09b55cd31f9812a` | `c09b55cd31f9812a` |
| Size | 10124 | 10240 |
| Tick Size | 168 | 170 |
| Match | **SIZE MISMATCH** | |

**CRITICAL FINDING:** Tick sizes differ:
- Yogurt: 168 bytes per tick
- Red: 170 bytes per tick

This affects the overall TickArray size:
- Yogurt: 44 + 60*168 = 10124
- Red: 44 + 60*170 = 10240

**Layout within tick (Both agree on critical fields):**
```
Offset    Field
------    -----
0..4      tick (i32)
4..20     liquidityNet (i128)
20..36    liquidityGross (u128)
```

### Swap Instruction Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| swap disc | `f8c69e91e17587c8` | `2b04ed0b1ac91e62` |
| swap_v2 disc | `2b04ed0b1ac91e62` | (same) |
| Match | **BOTH SUPPORT V2** | |

---

## 4. Meteora DLMM Decoder Comparison

### LbPair (Pool) Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | `meteoraDlmm.ts` | `meteoraLbPair.ts` |
| Discriminator | `210b3162b565b10d` | `210b3162b565b10d` |
| Size | 904 bytes | 904 bytes |
| Match | **MOSTLY ALIGNED** | |

**Layout Comparison:**

| Field | Yogurt Offset | Red Offset | Match |
|-------|--------------|------------|-------|
| baseFactor | 8..10 | 8..10 | YES |
| protocolShare | 32..34 | 32..34 | YES |
| volatilityAccumulator | 40..44 | 40..44 | YES |
| volatilityReference | 44..48 | 44..48 | YES |
| activeId | 76..80 | 76..80 | YES |
| binStep | 80..82 | 80..82 | YES |
| status | 82 | 82 | YES |
| tokenXMint | 88..120 | 88..120 | YES |
| tokenYMint | 120..152 | 120..152 | YES |
| reserveX | 152..184 | 152..184 | YES |
| reserveY | 184..216 | 184..216 | YES |
| binArrayBitmap | 216..344 | 440..568 | **MISMATCH** |

**CRITICAL FINDING:** binArrayBitmap offset differs:
- Yogurt: 216
- Red: 440

Red's decoder has explicit documentation of intermediate fields (protocolFee struct, padding, rewardInfos, oracle) that account for the larger offset.

### BinArray Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| File | `binArray.ts` | `meteoraBinArray.ts` |
| Discriminator | `5c8e5cdc059446b5` | `5c8e5cdc059446b5` |
| Header Size | 56 | 56 |
| Bin Size | 144 | 144 |
| Bins Per Array | 70 | 70 |
| Total Size | 10136 | 10136 |
| Match | **EXACT** | |

### Swap Instruction Decoder

| Aspect | Yogurt | Red |
|--------|--------|-----|
| swap | `f8c69e91e17587c8` | `f8c69e91e17587c8` |
| swap2 | `414b3f4ceb5b5b88` | `414b3f4ceb5b5b88` |
| swap_exact_out | `fa496521cdf4bb8` (derived) | N/A |
| Match | **YOGURT MORE COMPLETE** | |

**Yogurt supports 6 swap variants:**
1. `swap` - legacy exact input
2. `swap2` - current exact input
3. `swap_exact_out` - exact output
4. `swap_with_price_impact` - price limit
5. `swap2_exact_out` - v2 exact output
6. `swap2_with_price_impact` - v2 price limit

---

## 5. Regression Testing Approach (Red)

Red has comprehensive regression testing infrastructure:

### Files
- `runCanonicalRegression.ts` - Main regression harness
- `runCanonicalReplay.ts` - Replay harness
- `diagnosePumpSwapModels.ts` - PumpSwap fee analysis

### Test Case Format (CanonicalSwapCase)
```typescript
interface CanonicalSwapCase {
    signature: string;
    slot: number;
    venue: string;
    preAccounts: Record<string, RawAccountStateJson>;
    postAccounts: Record<string, RawAccountStateJson>;
    tokenBalances: Record<string, { preAmount: string; postAmount: string }>;
    tx?: { err?: any };
}
```

### Validation Methodology
1. Load pre-state from NDJSON fixture
2. Derive swap direction from vault delta signs
3. Calculate amountIn/actualOut from deltas
4. Run simulation with pre-state reserves
5. Compare simulated output to actual output
6. Report mismatches > 1 unit (rounding tolerance)

### Key Insights from Regression Code

**PumpSwap Fee Analysis:**
```typescript
// Test multiple fee hypotheses
const feesBps20 = { lpFeeBps: 20n, protocolFeeBps: 0n, coinCreatorFeeBps: 0n };
const feesBps24 = { lpFeeBps: 20n, protocolFeeBps: 4n, coinCreatorFeeBps: 0n };
const feesBps25 = { lpFeeBps: 20n, protocolFeeBps: 5n, coinCreatorFeeBps: 0n };

// Also test ceiling vs floor fee deduction
const ceilFee25 = (grossOut * 25n + 9999n) / 10000n;
```

**CLMM Tick Array Fetching:**
```typescript
// Derive needed tick arrays from current tick
const ticksPerArray = pool.tickSpacing * RAYDIUM_TICKS_PER_ARRAY;
const currentStartIndex = getTickArrayStartIndex(pool.tickCurrent, pool.tickSpacing);
const neededIndices = [
    currentStartIndex,
    currentStartIndex - ticksPerArray,
    currentStartIndex + ticksPerArray,
];
```

---

## 6. Gaps in Yogurt

### Missing Decoders

| Decoder | Impact | Priority |
|---------|--------|----------|
| OpenOrders (V4) | Reserve accuracy | HIGH |
| FeeConfig (pump_fees) | Fee tier selection | MEDIUM |
| TickArrayBitmapExtension | Extended tick range | LOW |
| BinArrayBitmapExtension | Extended bin range | LOW |

### Missing Fields

| Pool | Missing Fields | Impact |
|------|---------------|--------|
| V4 | marketId, lpReserve, poolOpenTime | Analytics |
| CLMM | feeGrowthGlobal*, swap counters | Analytics |
| LbPair | oracle, intermediate padding | Accuracy |

### Offset Discrepancies to Investigate

1. **CLMM tickArrayBitmap:** Yogurt=904, Red=840
2. **LbPair binArrayBitmap:** Yogurt=216, Red=440
3. **TickArray size:** Yogurt=10124, Red=10240

---

## 7. Recommended Actions

### Immediate (High Priority)

1. **Verify tickArrayBitmap offset** on mainnet accounts
   - Decode a known CLMM pool and check bitmap values
   - Red's offset (840) has explicit padding documentation

2. **Verify binArrayBitmap offset** on mainnet accounts
   - Red's offset (440) accounts for intermediate structs
   - Yogurt's offset (216) may be outdated

3. **Port OpenOrders decoder** from Red
   - Required for accurate V4 effective reserves
   - Formula: `effectiveReserve = vault - needTakePnl + openOrdersTotal`

### Short-term (Medium Priority)

4. **Add pump_fees FeeConfig decoder**
   - Port `pumpFeesFeeConfig.ts` from Red
   - Enables market-cap-based fee tier selection

5. **Verify TickArray tick size** (168 vs 170)
   - Affects total account size (10124 vs 10240)
   - Both should work if only reading critical fields

### Long-term (Low Priority)

6. **Add extension bitmap decoders**
   - TickArrayBitmapExtension for CLMM
   - BinArrayBitmapExtension for DLMM

7. **Add analytics fields** to pool decoders
   - feeGrowthGlobal, swap counters, etc.

---

## 8. Code to Port

### OpenOrders Decoder (from Red)

```typescript
// src/decode/programs/openOrders.ts
export const OPEN_ORDERS_SIZE = 3228;
export const OPEN_ORDERS_MAGIC = new Uint8Array([0x73, 0x65, 0x72, 0x75, 0x6d]); // "serum"

export const OPEN_ORDERS_OFFSETS = {
    magic: 0,      // 5 bytes
    version: 5,    // u8
    market: 13,    // Pubkey
    owner: 45,     // Pubkey
    baseTokenFree: 77,   // u64
    baseTokenTotal: 85,  // u64
    quoteTokenFree: 93,  // u64
    quoteTokenTotal: 101, // u64
} as const;

export interface OpenOrdersState {
    market: Uint8Array;
    owner: Uint8Array;
    version: number;
    baseTokenFree: bigint;
    baseTokenTotal: bigint;
    quoteTokenFree: bigint;
    quoteTokenTotal: bigint;
}

export function isOpenOrders(data: Uint8Array): boolean {
    if (data.length !== OPEN_ORDERS_SIZE) return false;
    for (let i = 0; i < 5; i++) {
        if (data[i] !== OPEN_ORDERS_MAGIC[i]) return false;
    }
    return true;
}

export function decodeOpenOrders(data: Uint8Array): OpenOrdersState | null {
    if (!isOpenOrders(data)) return null;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    return {
        version: data[5]!,
        market: data.slice(13, 45),
        owner: data.slice(45, 77),
        baseTokenFree: view.getBigUint64(77, true),
        baseTokenTotal: view.getBigUint64(85, true),
        quoteTokenFree: view.getBigUint64(93, true),
        quoteTokenTotal: view.getBigUint64(101, true),
    };
}
```

### Pump Fees FeeConfig Decoder (from Red)

```typescript
// src/decode/programs/pumpFees.ts
export const PUMP_FEES_PROGRAM_ID = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const FEE_CONFIG_DISC = new Uint8Array([0x8f, 0x34, 0x92, 0xbb, 0xdb, 0x7b, 0x4c, 0x9b]);

export interface PumpFeesBps {
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
    coinCreatorFeeBps: bigint;
}

export interface PumpFeeTier {
    marketCapThreshold: bigint;
    fees: PumpFeesBps;
}

export interface PumpFeeConfig {
    bump: number;
    admin: Uint8Array;
    flatFees: PumpFeesBps;
    feeTiers: PumpFeeTier[];  // Sorted ascending by threshold
}

export function isFeeConfig(data: Uint8Array): boolean {
    if (data.length < 8) return false;
    for (let i = 0; i < 8; i++) {
        if (data[i] !== FEE_CONFIG_DISC[i]) return false;
    }
    return true;
}

// See Red's pumpFeesFeeConfig.ts for full implementation
```

---

## 9. Conclusion

Both codebases share the same fundamental approach to decoding Solana DEX accounts, with matching discriminators and core field offsets for the primary pool types. However, there are notable differences:

1. **Yogurt is optimized for hot-path execution** with Uint8Array-based operations
2. **Red has richer type information** and additional analytics fields
3. **Critical offset discrepancies exist** in bitmap positions that need mainnet verification
4. **Yogurt is missing OpenOrders** decoder essential for V4 accuracy
5. **Red's regression framework** provides excellent validation patterns to adopt

The recommended approach is to:
1. Verify disputed offsets against mainnet accounts
2. Port the OpenOrders decoder immediately
3. Consider porting the pump_fees decoder for better fee accuracy
4. Adopt Red's regression testing methodology
