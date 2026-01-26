# State Update Skill

Maintain accurate CURRENT_STATE.json for agent handoff and session continuity.

## Usage

```
/state-update [context]
```

**Context:** Brief description of what triggered the update (capture, proving, fix, gap, session-end)

## Workflow

### 1. Read Current State

Always read CURRENT_STATE.json before modifying:

```bash
cat CURRENT_STATE.json
```

Verify JSON is valid before proceeding.

### 2. Apply Updates Based on Context

#### After Evidence Capture
Update evidence section:
```json
{
  "evidence": {
    "status": "FRESH",
    "sessionId": "<uuid>",
    "captureDate": "<YYYY-MM-DD>",
    "capturedSwaps": { ... }
  }
}
```

#### After Proving Run
Update venue baseline:
```json
{
  "venueStatus": {
    "<venue>": {
      "truePassRate": "<rate>%",
      "baselineDate": "<date>",
      "baselineDetails": { ... }
    }
  }
}
```

#### After Fix Applied
Mark issue as FIXED:
```json
{
  "venueStatus": {
    "<venue>": {
      "issues": [
        {
          "id": "<ID>",
          "status": "FIXED",
          "fixedDate": "<date>",
          "fix": "<description of fix>"
        }
      ],
      "completedFixes": [
        "<description of what was fixed>"
      ]
    }
  }
}
```

#### After Gap Found
Add new issue:
```json
{
  "venueStatus": {
    "<venue>": {
      "issues": [
        {
          "id": "<VN-XXX>",
          "title": "<short title>",
          "description": "<detailed description>",
          "status": "identified",
          "priority": "high|medium|low",
          "file": "<file path>",
          "lines": "<line range>"
        }
      ]
    }
  }
}
```

#### Before Session End
Update session metadata:
```json
{
  "lastUpdated": "<YYYY-MM-DD>",
  "updatedBy": "Claude <model>",
  "sessionSummary": "<1-2 sentence summary of what was accomplished>"
}
```

Update nextActions if priorities changed.

### 3. Validate Update

After any modification:
- Ensure JSON is valid (parseable)
- Ensure required fields are present
- Ensure no workaround references added
- Ensure terminology follows guidelines (no "simulation", "phase", etc.)

## Required Fields

| Field | Required | Description |
|-------|----------|-------------|
| lastUpdated | Yes | Date of last update |
| updatedBy | Yes | Who updated (model name) |
| sessionSummary | Yes | Brief summary |
| activeLayer | Yes | Current layer (1-4) |
| currentVenue | Yes | Current venue being worked |
| venueStatus | Yes | Status per venue |
| nextActions | Yes | Prioritized action list |

## Terminology Enforcement

**Use:**
- Local cache state
- Proving
- Math engines
- Layer 1 fix
- Gap
- Pool decoder / Instruction decoder

**Avoid:**
- Simulation
- Phase
- Workaround
- Bandaid

## Key Files

| File | Purpose |
|------|---------|
| `CURRENT_STATE.json` | Primary state file |
| `MENTAL_MAP.md` | Architecture reference |
| `LAYERS.md` | Layer definitions |
