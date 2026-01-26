# Proposal: Rename and Restructure Data Capture

## Problem

Current `profitStrategyAnalyzer.ts` has naming that primes AI analysis toward
finding "profit" and "strategy" patterns that may not exist. The data itself is
neutral, but the framing causes misinterpretation.

## Proposed Changes

### 1. Rename File
```
profitStrategyAnalyzer.ts → dexTransactionCollector.ts
```

### 2. Rename Output File
```
mev_capture_*.json → dex_transactions_*.json
```

### 3. Add Transaction Classification Fields

Add a new `transactionContext` field to each transaction:

```typescript
interface TransactionContext {
    // Transaction type classification (computed from structure)
    txType:
        | "AGGREGATOR_ROUTE"      // Uses Jupiter/aggregator, likely retail
        | "DIRECT_SINGLE_DEX"     // Single DEX, could be retail or MEV
        | "DIRECT_MULTI_DEX"      // Multiple DEXes without aggregator, likely MEV attempt
        | "UNKNOWN";

    // Classification confidence
    txTypeConfidence: "HIGH" | "MEDIUM" | "LOW";

    // Why classified this way
    txTypeReason: string;

    // Aggregator detection
    usesAggregator: boolean;
    aggregatorProgram: string | null;

    // Route complexity
    routeComplexity: "SIMPLE" | "MULTI_HOP" | "MULTI_VENUE";
}
```

### 4. Add Competition Context

Add per-slot competition tracking:

```typescript
interface SlotCompetitionContext {
    slot: number;

    // Pool-level competition
    poolCompetition: Array<{
        poolAccount: string;
        competingWallets: string[];
        competingSignatures: string[];
        winnerSignature: string | null;  // First to succeed
        winnerPosition: number;
    }>;

    // Wallet-level activity
    walletActivity: Array<{
        wallet: string;
        transactionCount: number;
        poolsTargeted: string[];
    }>;
}
```

### 5. Remove Biased Terminology from Comments

Current:
```typescript
// PURPOSE: Collect ALL raw data from DEX transactions for post-run analysis.
```

Proposed:
```typescript
// PURPOSE: Collect raw DEX transaction data without interpretation.
//
// IMPORTANT: This collector captures ALL DEX-touching transactions including:
// - Regular user swaps
// - Aggregator routes (Jupiter, etc.)
// - MEV bot activity
// - Failed transactions
//
// The data requires POST-CAPTURE CLASSIFICATION before analysis.
// Do NOT assume all captured transactions are MEV opportunities.
```

### 6. Output Structure Changes

Current output field names (neutral but incomplete):
```json
{
    "feePayerNetSolDeltaLamports": "...",  // OK but needs context
    "success": true,                        // OK
    "dexProgramsInvoked": [...]             // OK
}
```

Proposed additions:
```json
{
    "feePayerNetSolDeltaLamports": "...",
    "success": true,
    "dexProgramsInvoked": [...],

    // NEW: Classification (computed)
    "transactionContext": {
        "txType": "AGGREGATOR_ROUTE",
        "txTypeConfidence": "HIGH",
        "txTypeReason": "Uses Jupiter aggregator program",
        "usesAggregator": true,
        "aggregatorProgram": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
    },

    // NEW: Slot-relative context
    "slotContext": {
        "competitorsInSlot": 5,
        "competitorsOnSamePool": 2,
        "positionAmongCompetitors": 1,  // 1 = first
        "isFirstOnPool": true
    }
}
```

## Implementation Steps

1. Copy `profitStrategyAnalyzer.ts` to `dexTransactionCollector.ts`
2. Update comments to remove bias
3. Add `classifyTransaction()` function for txType
4. Add `buildSlotContext()` for competition tracking
5. Update output file naming
6. Deprecate old file name

## Analysis Impact

With these changes, analysis can:
1. Filter by txType BEFORE computing metrics
2. Separate "AGGREGATOR_ROUTE" from "DIRECT_MULTI_DEX"
3. Properly assess competition in specific segments
4. Avoid conflating retail with MEV

## Example: Corrected Cross-Venue Analysis

OLD (biased):
```
"Cross-venue arb: 33,743 transactions"
- Conflates Jupiter routing with MEV attempts
- Misleading success/profit rates
```

NEW (unbiased):
```
"Direct multi-DEX (no aggregator): 17,117 transactions"
"Aggregator routes (Jupiter): 16,626 transactions"
- Clear separation of intent
- Accurate metrics per category
```
