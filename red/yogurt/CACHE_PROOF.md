# Cache Proof Requirements

This document defines the requirements for proving that local cache state is reliable for each program.

---

## Current Status

| Program | Cache Validation | Math Validation | Ready |
|---------|------------------|-----------------|-------|
| PumpSwap | **VALIDATED** | VALIDATED (95.98%/100%) | YES |
| RaydiumV4 | **VALIDATED** | VALIDATED (98.26%/100%) | YES |
| RaydiumClmm | NOT_TESTED | NOT_TESTED | NO |
| MeteoraDlmm | NOT_TESTED | NOT_TESTED | NO |

---

## CPMM Cache Validation (PumpSwap, RaydiumV4)

### What Was Proven

```
gRPC post-state of slot N = pre-state for first TX in slot N+1
```

### Root Cause of Apparent Mismatches

Initial testing showed 98-99% match rates. Investigation revealed all mismatches were **validation methodology errors**:

- Our "first-in-slot" check only looked at `parsed_swaps`
- Unparsed TXs touched vaults earlier in the same slot
- Cache was correct; our comparison was flawed

**Conclusion:** Cache is 100% accurate at slot boundaries.

---

## Requirements for Remaining Programs

### RaydiumClmm

Requires validation of:
- Vault balances
- Pool state (current_tick, sqrt_price)
- Tick arrays for active range

### MeteoraDlmm

Requires validation of:
- Vault balances
- Pool state (active_bin_id)
- Bin arrays for active range
