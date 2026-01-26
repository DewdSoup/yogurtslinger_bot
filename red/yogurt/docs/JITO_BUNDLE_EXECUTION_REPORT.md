# Jito Bundle Execution Research Report

## Executive Summary

This report analyzes the current yogurt `execute/` infrastructure gaps and documents the reference implementation patterns from the `red/src/execution/` codebase. The goal is to provide actionable code snippets and architectural guidance for implementing production-ready Jito bundle submission.

---

## 1. Current Yogurt Execute Infrastructure Analysis

### 1.1 File Structure

```
src/execute/
├── bundle.ts    # Bundle builder (stub implementation)
├── submit.ts    # JitoClient (stub implementation)
├── types.ts     # Type definitions
└── revenue.ts   # Opportunity logging (functional)
```

### 1.2 Current Gaps

| Component | Status | Gap Description |
|-----------|--------|-----------------|
| `buildSwapTransaction()` | STUB | Throws `"not implemented"` - missing venue-specific instruction builders |
| `buildTipTransaction()` | STUB | Throws `"not implemented"` - missing SOL transfer to Jito tip accounts |
| `submitBundle()` | STUB | Throws `"not implemented"` - missing gRPC/RPC submission logic |
| `getBundleStatus()` | STUB | Throws `"not implemented"` - missing status polling |
| Instruction encoders | MISSING | No venue-specific swap data builders |
| Account resolver | MISSING | No logic to resolve swap instruction accounts |
| jito-ts integration | MISSING | No gRPC searcher client |
| V0 transaction support | MISSING | No `TransactionMessage.compileToV0Message()` |

### 1.3 What Works

- **Tip account selection**: 8 Jito tip accounts are correctly defined
- **Compute unit estimation**: Base estimates per venue with 20% buffer
- **Revenue logging**: Async buffered JSONL logging with dust filtering
- **Type definitions**: `BundleTransaction`, `BundleRequest`, `JitoConfig` are well-defined

---

## 2. Reference Implementation Architecture

### 2.1 JitoBundleBuilder Class (from `red/src/execution/jitoBundleBuilder.ts`)

```typescript
export class JitoBundleBuilder {
    private config: JitoBundleConfig;
    private client: SearcherClient | null = null;
    private stats = {
        bundlesSubmitted: 0,
        bundlesAccepted: 0,
        bundlesRejected: 0,
        totalTipsPaid: BigInt(0),
    };

    constructor(config: JitoBundleConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        this.client = searcherClient(this.config.blockEngineUrl);
    }

    // Main entry point for arb bundles
    async submitArbBundle(
        opportunity: ArbOpportunity,
        buyInstructions: SwapInstructionParams,
        sellInstructions: SwapInstructionParams,
        triggerTx?: VersionedTransaction
    ): Promise<BundleSubmitResult>;
}
```

**Key Dependencies:**
- `jito-ts/dist/sdk/block-engine/searcher` for `searcherClient()`
- `jito-ts/dist/sdk/block-engine/types` for `Bundle` class

### 2.2 Bundle Assembly Pattern

```typescript
// 1. Get recent blockhash
const { blockhash } = await connection.getLatestBlockhash("confirmed");

// 2. Build arb transaction with compute budget
const arbTx = await this.buildArbTransaction(buyIx, sellIx, inputAmount, blockhash);

// 3. Build tip transaction
const tipTx = await this.buildTipTransaction(tipLamports, blockhash);

// 4. Assemble bundle in order
const transactions: VersionedTransaction[] = [];
if (triggerTx) transactions.push(triggerTx);  // Optional backrun target
transactions.push(arbTx);                       // Our arb execution
transactions.push(tipTx);                       // Jito tip

// 5. Submit via gRPC
const bundleId = await this.submitBundle(transactions);
```

### 2.3 Compute Budget Integration

```typescript
const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,  // Max CU per transaction
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 1_000,  // Priority fee
    }),
    // ... swap instructions
];
```

---

## 3. Instruction Discriminators by Venue

### 3.1 PumpSwap

```typescript
// Anchor discriminator: SHA256("global:swap")[0:8]
const PUMPSWAP_SWAP_DISC = Buffer.from("66063d1201daebea", "hex");

// Instruction layout: [disc: 8][amount_out: u64][max_in: u64][direction?: u8]
// Data lengths observed: 24, 25, 26, 32 bytes

export function buildPumpSwapSwapData(
    amountIn: bigint,
    minAmountOut: bigint
): Buffer {
    const disc = Buffer.from("66063d1201daebea", "hex");
    const data = Buffer.alloc(24);
    disc.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);
    return data;
}

// Account layout (from IDL):
// 0: pool
// 1: user
// 2: globalConfig
// 3: baseMint
// 4: quoteMint
// 5: userBaseTokenAccount
// 6: userQuoteTokenAccount
// 7: poolBaseTokenAccount
// 8: poolQuoteTokenAccount
// ...
```

**Note**: PumpSwap uses exact-out semantics by default. The instruction specifies the exact output amount and max input.

### 3.2 Raydium V4

```typescript
// Native instruction (not Anchor) - instruction index 9 = swap
const RAYDIUM_V4_SWAP_IX = 9;

// Instruction layout: [ix_index: u8][amount_in: u64][min_out: u64]
// Total: 17 bytes

export function buildRaydiumV4SwapData(
    amountIn: bigint,
    minAmountOut: bigint
): Buffer {
    const data = Buffer.alloc(17);
    data.writeUInt8(9, 0);  // Instruction index
    data.writeBigUInt64LE(amountIn, 1);
    data.writeBigUInt64LE(minAmountOut, 9);
    return data;
}

// Account layout:
// 0: tokenProgram
// 1: amm
// 2: ammAuthority
// 3: ammOpenOrders
// 4: ammTargetOrders (deprecated)
// 5: poolCoinTokenAccount
// 6: poolPcTokenAccount
// 7: serumProgram
// 8: serumMarket
// 9: serumBids
// 10: serumAsks
// 11: serumEventQueue
// 12: serumCoinVaultAccount
// 13: serumPcVaultAccount
// 14: serumVaultSigner
// 15: userSourceTokenAccount
// 16: userDestTokenAccount
// 17: userOwner
```

### 3.3 Raydium CLMM

```typescript
// Anchor discriminator: SHA256("global:swap")[0:8]
const CLMM_SWAP_DISC = Buffer.from("2b04ed0b1ac91e62", "hex");

// Instruction layout:
// [disc: 8][amount: u64][other_threshold: u64][sqrt_limit: u128][is_base_input: u8]
// Total: 41 bytes

export function buildRaydiumClmmSwapData(
    amount: bigint,
    otherThreshold: bigint,
    sqrtPriceLimitX64: bigint,
    isBaseInput: boolean
): Buffer {
    const disc = Buffer.from("2b04ed0b1ac91e62", "hex");
    const data = Buffer.alloc(41);
    disc.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    data.writeBigUInt64LE(otherThreshold, 16);
    // u128 sqrtPriceLimitX64 (little-endian)
    data.writeBigUInt64LE(sqrtPriceLimitX64 & BigInt("0xFFFFFFFFFFFFFFFF"), 24);
    data.writeBigUInt64LE(sqrtPriceLimitX64 >> BigInt(64), 32);
    data.writeUInt8(isBaseInput ? 1 : 0, 40);
    return data;
}

// Account layout:
// 0: payer
// 1: ammConfig
// 2: poolState
// 3: inputTokenAccount
// 4: outputTokenAccount
// 5: inputVault
// 6: outputVault
// 7: observationState
// 8: tokenProgram
// 9: tickArrayLower
// 10: tickArrayUpper
// ...remaining tick arrays
```

### 3.4 Meteora DLMM

```typescript
// Anchor discriminator variants observed in production:
const DLMM_SWAP_DISCS = [
    Buffer.from("f8c69e91e17587c8", "hex"),  // Primary swap
    Buffer.from("414b3f4ceb5b5b88", "hex"),  // Alternative
    Buffer.from("235613b94ed44bd3", "hex"),  // Legacy
];

// Instruction layout: [disc: 8][amount_in: u64][min_out: u64]
// Total: 24 bytes

export function buildMeteoraDlmmSwapData(
    amountIn: bigint,
    minAmountOut: bigint
): Buffer {
    const disc = Buffer.from("235613b94ed44bd3", "hex");
    const data = Buffer.alloc(24);
    disc.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minAmountOut, 16);
    return data;
}

// Account layout:
// 0: lbPair
// 1: binArrayBitmapExtension (optional)
// 2: reserveX
// 3: reserveY
// 4: userTokenIn
// 5: userTokenOut
// 6: tokenXMint
// 7: tokenYMint
// 8: oracle
// 9: hostFeeIn
// 10: user
// 11: tokenXProgram
// 12: tokenYProgram
// 13: eventAuthority
// 14: program
// 15+: binArrays...
```

---

## 4. Jito Tip Strategy

### 4.1 Eight Tip Accounts

```typescript
const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
```

### 4.2 Load Balancing Strategy

```typescript
// Random selection distributes load across Jito infrastructure
function selectTipAccount(): PublicKey {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[index]);
}
```

### 4.3 Tip Transaction Construction

```typescript
async buildTipTransaction(
    tipLamports: bigint,
    blockhash: string
): Promise<VersionedTransaction> {
    const tipAccount = selectTipAccount();

    const instruction = SystemProgram.transfer({
        fromPubkey: this.config.signerKeypair.publicKey,
        toPubkey: tipAccount,
        lamports: Number(tipLamports),
    });

    return this.buildTransaction([instruction], blockhash);
}
```

### 4.4 Tip Amount Guidelines

| Scenario | Recommended Tip | Notes |
|----------|----------------|-------|
| Minimum viable | 0.0001 SOL (100,000 lamports) | May not land in competitive slots |
| Default | 0.001 SOL (1,000,000 lamports) | Reasonable landing rate |
| Competitive | 0.005-0.01 SOL | High-value opportunities |
| Dynamic | % of expected profit | Scale with opportunity value |

---

## 5. Bundle Atomicity Patterns

### 5.1 Backrun Bundle Structure

```
[Trigger TX (victim)]  →  [Arb TX]  →  [Tip TX]
         ↑                    ↑            ↑
    Not our tx           Our swap    Jito payment
```

**Key Property**: All transactions land in same slot or none land.

### 5.2 Standalone Bundle Structure

```
[Arb TX (buy + sell)]  →  [Tip TX]
         ↑                    ↑
  Both legs atomic      Jito payment
```

### 5.3 Multi-Hop Arb Bundle

```typescript
// Both legs in single transaction for atomicity
const instructions: TransactionInstruction[] = [
    // Compute budget
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),

    // Buy leg (venue A)
    new TransactionInstruction({
        programId: buyInstructions.programId,
        keys: buyInstructions.accounts.map(pk => ({
            pubkey: pk,
            isSigner: pk.equals(signerKeypair.publicKey),
            isWritable: true,
        })),
        data: buyInstructions.data,
    }),

    // Sell leg (venue B)
    new TransactionInstruction({
        programId: sellInstructions.programId,
        keys: sellInstructions.accounts.map(pk => ({
            pubkey: pk,
            isSigner: pk.equals(signerKeypair.publicKey),
            isWritable: true,
        })),
        data: sellInstructions.data,
    }),
];
```

---

## 6. gRPC Submission Logic

### 6.1 Using jito-ts SDK

```typescript
import { searcherClient, type SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";

// Initialize client
const client = searcherClient("https://mainnet.block-engine.jito.wtf");

// Build bundle
const bundle = new Bundle(transactions, 5);  // 5 tx limit

// Add tip using Bundle's built-in method
const bundleWithTip = bundle.addTipTx(
    signerKeypair,
    Number(tipLamports),
    tipAccount,
    blockhash
);

if (bundleWithTip instanceof Error) {
    throw bundleWithTip;
}

// Submit via gRPC
const result = await client.sendBundle(bundleWithTip);

if (!result.ok) {
    throw new Error(`Bundle submission failed: ${result.error?.message}`);
}

const bundleId = result.value;  // UUID for status tracking
```

### 6.2 Block Engine Endpoints

| Network | Endpoint |
|---------|----------|
| Mainnet | `https://mainnet.block-engine.jito.wtf` |
| Mainnet (alternative) | `https://ny.mainnet.block-engine.jito.wtf` |
| Mainnet (alternative) | `https://amsterdam.mainnet.block-engine.jito.wtf` |
| Mainnet (alternative) | `https://frankfurt.mainnet.block-engine.jito.wtf` |
| Mainnet (alternative) | `https://tokyo.mainnet.block-engine.jito.wtf` |

### 6.3 Bundle Status Checking

```typescript
// After submission, poll for status
const statuses = await client.getBundleStatuses([bundleId]);

for (const status of statuses) {
    if (status.bundle_id === bundleId) {
        console.log(`Bundle ${bundleId} status: ${status.status}`);
        // status can be: "Invalid", "Pending", "Landed", "Failed"
    }
}
```

---

## 7. Integration Snippets for Yogurt

### 7.1 Enhanced `buildSwapTransaction()`

```typescript
import {
    Connection,
    Keypair,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
} from "@solana/web3.js";
import type { Opportunity, PoolState, VenueId } from '../types.js';

function buildSwapTransaction(
    opportunity: Opportunity,
    poolState: PoolState,
    payerKeypair: Keypair,
    blockhash: string,
    config: BundleConfig
): VersionedTransaction {
    const instructions: TransactionInstruction[] = [];

    // 1. Compute budget
    instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({
            units: config.computeUnitLimit,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Number(config.computeUnitPrice),
        })
    );

    // 2. Build venue-specific swap instruction
    const swapIx = buildSwapInstruction(opportunity, poolState, payerKeypair.publicKey);
    instructions.push(swapIx);

    // 3. Compile to V0 message
    const messageV0 = new TransactionMessage({
        payerKey: payerKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message();

    // 4. Create and sign
    const tx = new VersionedTransaction(messageV0);
    tx.sign([payerKeypair]);

    return tx;
}

function buildSwapInstruction(
    opportunity: Opportunity,
    poolState: PoolState,
    payer: PublicKey
): TransactionInstruction {
    switch (opportunity.venue) {
        case VenueId.PumpSwap:
            return buildPumpSwapInstruction(opportunity, poolState, payer);
        case VenueId.RaydiumV4:
            return buildRaydiumV4Instruction(opportunity, poolState, payer);
        case VenueId.RaydiumClmm:
            return buildRaydiumClmmInstruction(opportunity, poolState, payer);
        case VenueId.MeteoraDlmm:
            return buildMeteoraDlmmInstruction(opportunity, poolState, payer);
        default:
            throw new Error(`Unsupported venue: ${opportunity.venue}`);
    }
}
```

### 7.2 Enhanced `buildTipTransaction()`

```typescript
function buildTipTransaction(
    payerKeypair: Keypair,
    tipLamports: bigint,
    blockhash: string
): VersionedTransaction {
    const tipAccount = new PublicKey(selectTipAccount());

    const instruction = SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey: tipAccount,
        lamports: Number(tipLamports),
    });

    const messageV0 = new TransactionMessage({
        payerKey: payerKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [instruction],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([payerKeypair]);

    return tx;
}
```

### 7.3 Enhanced `JitoClient.submitBundle()`

```typescript
import { searcherClient, type SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";

export class JitoClient {
    private config: JitoConfig;
    private client: SearcherClient | null = null;

    async connect(): Promise<void> {
        this.client = searcherClient(this.config.endpoint);
    }

    async submitBundle(transactions: VersionedTransaction[]): Promise<BundleResult> {
        if (!this.client) {
            throw new Error("Client not connected");
        }

        const startMs = Date.now();

        try {
            // Create Bundle object
            const bundle = new Bundle(transactions, 5);

            // Submit via gRPC
            const result = await this.client.sendBundle(bundle);

            if (!result.ok) {
                return {
                    bundleId: '',
                    submitted: false,
                    error: result.error?.message ?? 'Unknown error',
                    latencyMs: Date.now() - startMs,
                };
            }

            return {
                bundleId: result.value,
                submitted: true,
                latencyMs: Date.now() - startMs,
            };

        } catch (e) {
            return {
                bundleId: '',
                submitted: false,
                error: String(e),
                latencyMs: Date.now() - startMs,
            };
        }
    }
}
```

---

## 8. Required Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@solana/web3.js": "^1.95.0",
    "jito-ts": "^4.1.0"
  }
}
```

---

## 9. Recommended Implementation Order

1. **Phase 1**: Implement instruction encoders for each venue
   - Start with PumpSwap (simplest layout)
   - Add RaydiumV4, then CLMM, then DLMM

2. **Phase 2**: Implement account resolution
   - Map opportunity pool state to instruction account lists
   - Handle user token accounts (ATA derivation)

3. **Phase 3**: Wire up jito-ts
   - Connect to block engine
   - Implement Bundle creation
   - Add tip transaction via Bundle.addTipTx()

4. **Phase 4**: Transaction assembly
   - V0 message compilation
   - Signing with payer keypair
   - Compute budget optimization

5. **Phase 5**: Submission and monitoring
   - gRPC submission
   - Status polling
   - Retry logic with exponential backoff

---

## 10. Program IDs Reference

```typescript
export const PROGRAM_IDS = {
    PumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    RaydiumV4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    RaydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    MeteoraDlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    SystemProgram: "11111111111111111111111111111111",
    TokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    Token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    AssociatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
} as const;
```

---

## Appendix A: Complete SwapInstruction Type

```typescript
interface SwapInstructionParams {
    venue: VenueId;
    programId: PublicKey;
    accounts: AccountMeta[];
    data: Buffer;
}

interface AccountMeta {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
}
```

---

## Appendix B: Error Handling

```typescript
export const BundleErrors = {
    SIMULATION_FAILURE: "Bundle simulation failed",
    INVALID_SIGNATURE: "Invalid transaction signature",
    ACCOUNT_NOT_FOUND: "Required account not found",
    INSUFFICIENT_FUNDS: "Insufficient lamports for tip",
    EXPIRED_BLOCKHASH: "Blockhash has expired",
    BUNDLE_FULL: "Bundle exceeds 5 transaction limit",
} as const;
```
