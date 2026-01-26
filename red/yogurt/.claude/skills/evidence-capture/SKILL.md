# Evidence Capture Skill

Run evidence capture workflow with pre-flight checks and post-capture validation.

## Usage

```
/evidence-capture [duration_seconds]
```

**Arguments:**
- `duration_seconds` (optional): Duration in seconds. Default: run indefinitely until Ctrl+C

## Workflow

### 1. Pre-flight Checks

Before starting capture, verify:

```bash
# Check gRPC endpoint is accessible
nc -zv 127.0.0.1 10000

# Check database directory exists
ls -la data/evidence/

# Check for any running capture sessions
ps aux | grep capture-evidence
```

If pre-flight fails:
- Report which check failed
- Suggest remediation
- Do NOT proceed with capture

### 2. Execute Capture

Run the evidence capture script:

```bash
pnpm evidence <duration>
# or
npx tsx scripts/capture-evidence.ts <duration>
```

Monitor output for:
- gRPC connection status
- Slot updates
- Transaction captures
- Any errors

### 3. Post-Capture Validation

After capture completes, verify data was captured:

```bash
# Check database exists and has data
sqlite3 data/evidence/capture.db "SELECT COUNT(*) FROM mainnet_txs;"
sqlite3 data/evidence/capture.db "SELECT COUNT(*) FROM parsed_swaps;"
sqlite3 data/evidence/capture.db "SELECT COUNT(*) FROM mainnet_updates;"

# Get swap counts per venue
sqlite3 data/evidence/capture.db "SELECT venue, COUNT(*) FROM parsed_swaps GROUP BY venue;"
```

Report:
- Total transactions captured
- Total swaps parsed (per venue)
- Date range of captured data
- Any warnings or errors

### 4. Update CURRENT_STATE.json

Update the evidence section:

```json
{
  "evidence": {
    "status": "FRESH",
    "sessionId": "<new-uuid>",
    "captureDate": "<today>",
    "capturedSwaps": {
      "pumpswap": "<count>",
      "raydiumV4": "<count or not_captured>",
      ...
    }
  }
}
```

## NO BANDAIDS Rule

This skill only captures evidence. It does NOT:
- Modify any Layer 1 code
- Apply any workarounds
- Skip any transactions

If capture fails, investigate root cause in Layer 1.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/capture-evidence.ts` | Main capture script |
| `data/evidence/capture.db` | SQLite evidence database |
| `CURRENT_STATE.json` | State to update after capture |
