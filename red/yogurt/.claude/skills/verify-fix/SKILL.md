# Verify Fix Skill

Verify Layer 1 fixes via typecheck, build, and proving run before marking complete.

## Usage

```
/verify-fix [issue-id]
```

**Arguments:**
- `issue-id` (optional): The issue ID to verify (e.g., PS-001). If omitted, verifies all pending fixes.

## Workflow

### 1. Typecheck

```bash
pnpm typecheck
```

**Gate:** Must pass with zero errors. Type errors indicate incomplete or incorrect fix.

### 2. Build

```bash
pnpm build
```

**Gate:** Must succeed. Build failures block verification.

### 3. Run Proving Script

```bash
npx tsx scripts/prove-infrastructure.ts \
  --venue <venue> \
  --limit 5000 \
  --tolerance-bps 10
```

Record results:
- passRate
- p50/p95/p99 error
- directionMatchRate
- Worst pools

### 4. Compare to Baseline

Read baseline from CURRENT_STATE.json:
```json
{
  "venueStatus": {
    "<venue>": {
      "baselineDetails": {
        "passRate": "XX%",
        ...
      }
    }
  }
}
```

**Gate Rules:**
| Metric | Requirement |
|--------|-------------|
| passRate | Must improve or stay same |
| directionMatchRate | Must improve or stay same |
| p99 | Should not regress significantly |

### 5. Update State

Only if ALL gates pass:

```json
{
  "venueStatus": {
    "<venue>": {
      "issues": [
        {
          "id": "<ID>",
          "status": "FIXED",
          "fixedDate": "<today>",
          "fix": "<description>"
        }
      ],
      "completedFixes": [
        "<new fix added>"
      ],
      "baselineDetails": {
        // Updated with new measurements
      }
    }
  }
}
```

### 6. Report Results

Output summary:
```
Fix Verification: <issue-id>
========================
Typecheck: PASS/FAIL
Build: PASS/FAIL
Proving Run:
  - passRate: XX% (baseline: XX%)
  - directionMatch: XX% (baseline: XX%)
  - p50/p95/p99: X/X/X bps

Verdict: VERIFIED / FAILED
```

## NO BANDAIDS Enforcement

Before marking FIXED, verify:
- [ ] Fix is in Layer 1 code (src/sim/math/, src/decode/programs/, src/cache/)
- [ ] No feeOracle or runtime fee learning
- [ ] No feeOverrideBps or override mechanisms
- [ ] No tolerance inflation without justification
- [ ] No skipping of failing transactions

If workaround detected:
1. Reject the fix
2. Explain why it violates NO BANDAIDS rule
3. Suggest proper Layer 1 approach

## Key Files

| File | Purpose |
|------|---------|
| `scripts/prove-infrastructure.ts` | Proving script |
| `CURRENT_STATE.json` | Baseline and state |
| `src/sim/math/constantProduct.ts` | CPMM math (Layer 1) |
| `src/decode/programs/pumpswap.ts` | PumpSwap (Layer 1) |
