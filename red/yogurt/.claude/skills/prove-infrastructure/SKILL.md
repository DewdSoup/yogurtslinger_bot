# Prove Infrastructure Skill

Run infrastructure proving and analyze results with strict NO BANDAIDS enforcement.

## Usage

```
/prove-infrastructure [--venue <venue>] [--limit <n>] [--tolerance-bps <n>]
```

**Arguments:**
- `--venue`: Venue to test (pumpswap, raydiumV4, raydiumClmm, meteoraDlmm). Default: pumpswap
- `--limit`: Max swaps to evaluate. Default: 5000
- `--tolerance-bps`: Acceptable error in basis points. Default: 10

## CRITICAL: Full-Funnel Coverage Tracking

**FALSE POSITIVE WARNING:** Do not report passRate without context. A 97% passRate on 20% coverage means 19.4% TRUE coverage.

### Full-Funnel Metrics (ALL REQUIRED)

Before running proving, query the FULL funnel:

```sql
-- Full funnel breakdown
SELECT
  (SELECT COUNT(*) FROM mainnet_txs WHERE session_id = '<session>') as total_txs,
  (SELECT COUNT(*) FROM parsed_swaps WHERE session_id = '<session>') as decoded_swaps,
  (SELECT COUNT(*) FROM parsed_swaps WHERE session_id = '<session>' AND actual_output_amount IS NOT NULL AND actual_output_amount != '') as has_output,
  (SELECT COUNT(*) FROM parsed_swaps WHERE session_id = '<session>' AND venue = '<venue>') as venue_swaps;
```

**Report BOTH metrics:**

| Metric | Formula | Target |
|--------|---------|--------|
| decodeRate | decoded_swaps / total_txs | Track (gap = non-swap + decode failures) |
| outputRate | has_output / decoded_swaps | 100% |
| evaluatedRate | evaluated / venue_swaps | 100% |
| passRate | pass / evaluated | 100% |
| **TRUE_COVERAGE** | pass / total_txs | This is what matters |

### Example Report Format

```
FULL FUNNEL REPORT
==================
Total transactions captured:     484,867
├─ Decoded to parsed_swaps:      233,672 (48.2%)  <- GAP: decode coverage
│  ├─ Has actual_output:         191,675 (82.0%)  <- GAP: output extraction
│  └─ PumpSwap venue:            220,576
│     ├─ Evaluated:               15,243 (6.9%)   <- GAP: skip reasons
│     │  └─ Passed:               14,796 (97.1%)  <- Math accuracy
│     └─ Skipped:                205,333
│        ├─ multi-swap:           50,000
│        ├─ dust:                 30,000
│        ├─ weird flow:           20,000
│        └─ ...

TRUE COVERAGE: 14,796 / 484,867 = 3.05%
```

## Workflow

### 1. Query Full Funnel First

Before running proving script, understand the denominator.

### 2. Execute Proving Script

```bash
npx tsx scripts/prove-infrastructure.ts \
  --venue <venue> \
  --limit <limit> \
  --tolerance-bps <tolerance>
```

### 3. Analyze Results WITH CONTEXT

Parse output for key metrics:

| Metric | Description | Target |
|--------|-------------|--------|
| passRate | % of EVALUATED within tolerance | 100% |
| evaluatedRate | % of venue swaps evaluated | 100% |
| decodeRate | % of txs decoded | Track & improve |
| TRUE_COVERAGE | pass / total_txs | This is reality |
| p50/p95/p99/max | Error distribution | 0/10/25/? bps |
| directionMatchRate | % correct direction | 100% |

### 3. Identify Gaps

If passRate < 100%, identify root causes:

**Pattern Analysis:**
- 0% pools → Likely different fee tier
- Direction mismatches → Decoder normalization bug
- Consistent bias → Math formula issue
- Random errors → State timing issue

**Assign Issue IDs:**
- PumpSwap: PS-XXX
- RaydiumV4: RV-XXX
- RaydiumClmm: RC-XXX
- MeteoraDlmm: MD-XXX

### 4. Update CURRENT_STATE.json

After each run, update:

```json
{
  "venueStatus": {
    "<venue>": {
      "truePassRate": "<rate>% (with <fee> bps, no workarounds)",
      "baselineDate": "<today>",
      "baselineDetails": {
        "evaluated": <n>,
        "passRate": "<rate>%",
        "p50": "<n> bps",
        "p95": "<n> bps",
        "p99": "<n> bps",
        "maxError": "<n> bps",
        "directionMatchRate": "<rate>%"
      }
    }
  }
}
```

## NO BANDAIDS Enforcement

**CRITICAL**: This skill enforces the NO BANDAIDS rule.

Do NOT accept or suggest:
- `feeOracle` or any runtime fee learning
- `feeOverrideBps` or fee override mechanisms
- `--dynamic-fee` or similar flags
- Tolerance inflation beyond 25 bps without justification
- Skipping failing transactions
- Any workaround that makes passRate look better without fixing Layer 1

**If a workaround is detected:**
1. Immediately flag it
2. Report quarantined file location
3. Refuse to proceed until Layer 1 fix is proposed

## Key Files

| File | Purpose |
|------|---------|
| `scripts/prove-infrastructure.ts` | Main proving script |
| `src/sim/math/constantProduct.ts` | CPMM math (fix here) |
| `src/decode/programs/pumpswap.ts` | PumpSwap decoder (fix here) |
| `CURRENT_STATE.json` | Update with results |
| `outdated/feeOracle.ts` | QUARANTINED - do not use |
