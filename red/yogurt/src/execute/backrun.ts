/**
 * CPMM Backrun Detection + Execution Engine
 *
 * Hot path: ShredStream pending tx → decode swap (PumpSwap or RaydiumV4) → read L1 cache →
 * simulate victim → simulate round-trip → profit check → build bundle → submit.
 *
 * All cache reads and math are synchronous. Only Jito submission is async (fire-and-forget).
 */

import type { Keypair } from '@solana/web3.js';
import type {
    IngestEvent,
    TxUpdate,
    SwapLeg,
    CompiledInstruction,
    PumpSwapPool,
    RaydiumV4Pool,
    BundleConfig,
    PoolState,
} from '../types.js';
import { VenueId, SwapDirection } from '../types.js';
import {
    simulateConstantProduct,
    getAmountIn,
} from '../sim/math/constantProduct.js';
import { isPumpSwapSwap, decodePumpSwapInstruction } from '../decode/programs/pumpswap.js';
import { isRaydiumV4Swap, decodeRaydiumV4Instruction } from '../decode/programs/raydiumV4.js';
import { buildBundle, estimateComputeUnits } from './bundle.js';
import type { SwapParams } from './bundle.js';
import type { JitoClient } from './submit.js';

// ============================================================================
// Program ID bytes (for fast program ID matching in hot path)
// ============================================================================

// PumpSwap: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
const PUMPSWAP_BYTES = new Uint8Array([
    0x0c, 0x14, 0xde, 0xfc, 0x82, 0x5e, 0xc6, 0x76,
    0x94, 0x25, 0x08, 0x18, 0xbb, 0x65, 0x40, 0x65,
    0xf4, 0x29, 0x8d, 0x31, 0x56, 0xd5, 0x71, 0xb4,
    0xd4, 0xf8, 0x09, 0x0c, 0x18, 0xe9, 0xa8, 0x63,
]);

// RaydiumV4: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
const RAYDIUMV4_BYTES = new Uint8Array([
    0x4b, 0xd9, 0x49, 0xc4, 0x36, 0x02, 0xc3, 0x3f,
    0x20, 0x77, 0x90, 0xed, 0x16, 0xa3, 0x52, 0x4c,
    0xa1, 0xb9, 0x97, 0x5c, 0xf1, 0x21, 0xa2, 0xa9,
    0x0c, 0xff, 0xec, 0x7d, 0xf8, 0xb6, 0x8a, 0xcd,
]);

// Candidate input sizes for optimal sizing (in lamports — always SOL-denominated)
const SIZE_CANDIDATES = [
    10_000_000n,     // 0.01 SOL
    50_000_000n,     // 0.05 SOL
    100_000_000n,    // 0.1 SOL
    250_000_000n,    // 0.25 SOL
    500_000_000n,    // 0.5 SOL
    1_000_000_000n,  // 1.0 SOL
];

// ============================================================================
// Types
// ============================================================================

export interface BackrunConfig {
    poolCache: { get(pubkey: Uint8Array): { state: PoolState; slot: number } | null };
    vaultCache: { get(pubkey: Uint8Array): { amount: bigint; slot: number } | null };
    payerKeypair: Keypair;
    jitoClient: JitoClient;
    minProfitLamports: bigint;
    tipLamports: bigint;
    computeUnitLimit: number;
    computeUnitPrice: bigint;
    slippageBps: number;
    getRecentBlockhash: () => string;
    dryRun?: boolean;
}

export interface BackrunStats {
    shredTxsReceived: bigint;
    swapsDetected: bigint;
    opportunitiesFound: bigint;
    bundlesBuilt: bigint;
    bundlesSubmitted: bigint;
    totalProfitLamports: bigint;
}

// ============================================================================
// Message Parsing (inline, minimal — just enough for swap leg extraction)
// ============================================================================

function pubkeyMatch(a: Uint8Array, b: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Read compactU16 from buffer, return [value, bytesConsumed] */
function readCompactU16(buf: Uint8Array, off: number): [number, number] {
    const b0 = buf[off];
    if (b0 <= 0x7f) return [b0, 1];
    const b1 = buf[off + 1];
    if (b0 <= 0xff && b1 <= 0x7f) return [((b0 & 0x7f) | (b1 << 7)), 2];
    const b2 = buf[off + 2];
    return [((b0 & 0x7f) | ((b1 & 0x7f) << 7) | (b2 << 14)), 3];
}

interface ParsedMessage {
    accountKeys: Uint8Array[];
    instructions: CompiledInstruction[];
}

/**
 * Minimal V0 legacy message parser. Extracts account keys + instructions.
 * Does NOT handle V0 versioned messages with ALTs (those need ALT resolution).
 */
function parseMessageMinimal(msg: Uint8Array): ParsedMessage | null {
    if (msg.length < 4) return null;

    let offset = 0;

    // Check version prefix
    const firstByte = msg[0];
    const isVersioned = (firstByte & 0x80) !== 0;

    if (isVersioned) {
        // Versioned message (V0) — has address table lookups that we can't resolve
        // without the ALT cache. For now, parse only static keys.
        offset = 1; // skip version byte
    }

    // Header: numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts
    if (offset + 3 > msg.length) return null;
    offset += 3;

    // Account keys
    const [numAccounts, numAccountsLen] = readCompactU16(msg, offset);
    offset += numAccountsLen;

    if (offset + numAccounts * 32 > msg.length) return null;

    const accountKeys: Uint8Array[] = [];
    for (let i = 0; i < numAccounts; i++) {
        accountKeys.push(msg.subarray(offset, offset + 32));
        offset += 32;
    }

    // Recent blockhash (32 bytes)
    if (offset + 32 > msg.length) return null;
    offset += 32;

    // Instructions
    const [numIxs, numIxsLen] = readCompactU16(msg, offset);
    offset += numIxsLen;

    const instructions: CompiledInstruction[] = [];
    for (let i = 0; i < numIxs; i++) {
        if (offset >= msg.length) break;

        // Program ID index
        const programIdIndex = msg[offset++];

        // Account indices
        const [numAccts, numAcctsLen] = readCompactU16(msg, offset);
        offset += numAcctsLen;
        if (offset + numAccts > msg.length) break;
        const accountKeyIndexes: number[] = [];
        for (let j = 0; j < numAccts; j++) {
            accountKeyIndexes.push(msg[offset++]);
        }

        // Instruction data
        const [dataLen, dataLenLen] = readCompactU16(msg, offset);
        offset += dataLenLen;
        if (offset + dataLen > msg.length) break;
        const data = msg.subarray(offset, offset + dataLen);
        offset += dataLen;

        instructions.push({ programIdIndex, accountKeyIndexes, data });
    }

    return { accountKeys, instructions };
}

// ============================================================================
// Pool Enrichment
// ============================================================================

type EnrichedPool = (PumpSwapPool | RaydiumV4Pool) & {
    baseReserve: bigint;
    quoteReserve: bigint;
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
};

function enrichPumpSwapPool(
    pool: PumpSwapPool,
    baseAmount: bigint,
    quoteAmount: bigint,
): EnrichedPool {
    return {
        ...pool,
        baseReserve: baseAmount,
        quoteReserve: quoteAmount,
        lpFeeBps: pool.lpFeeBps ?? 20n,
        protocolFeeBps: pool.protocolFeeBps ?? 5n,
    };
}

function enrichRaydiumV4Pool(
    pool: RaydiumV4Pool,
    baseAmount: bigint,
    quoteAmount: bigint,
): EnrichedPool {
    // PnL adjustment: effective reserves = vault balance - needTakePnl
    const baseReserve = baseAmount - pool.baseNeedTakePnl;
    const quoteReserve = quoteAmount - pool.quoteNeedTakePnl;

    // Convert swapFeeNumerator/Denominator → bps
    // RV4 bakes LP + protocol fee into a single numerator/denominator
    const feeBps = pool.swapFeeDenominator > 0n
        ? (pool.swapFeeNumerator * 10000n) / pool.swapFeeDenominator
        : 25n;

    return {
        ...pool,
        baseReserve,
        quoteReserve,
        lpFeeBps: feeBps,
        protocolFeeBps: 0n,
    };
}

// ============================================================================
// Engine
// ============================================================================

export function createBackrunEngine(config: BackrunConfig) {
    const stats: BackrunStats = {
        shredTxsReceived: 0n,
        swapsDetected: 0n,
        opportunitiesFound: 0n,
        bundlesBuilt: 0n,
        bundlesSubmitted: 0n,
        totalProfitLamports: 0n,
    };

    const gasCostLamports = BigInt(config.computeUnitLimit) * config.computeUnitPrice / 1_000_000n;

    const bundleConfig: BundleConfig = {
        tipLamports: config.tipLamports,
        computeUnitLimit: config.computeUnitLimit,
        computeUnitPrice: config.computeUnitPrice,
        maxRetries: 3,
        timeoutMs: 5000,
    };

    function handleShredEvent(event: IngestEvent): void {
        if (event.type !== 'tx' || event.source !== 'pending') return;

        stats.shredTxsReceived++;
        const update: TxUpdate = event.update;

        // Parse message to extract instructions + account keys
        const parsed = parseMessageMinimal(update.message);
        if (!parsed || parsed.instructions.length === 0) return;

        // Scan for CPMM swap instructions (PumpSwap + RaydiumV4)
        for (const ix of parsed.instructions) {
            const programId = parsed.accountKeys[ix.programIdIndex];
            if (!programId) continue;

            let leg: SwapLeg | null = null;

            if (pubkeyMatch(programId, PUMPSWAP_BYTES)) {
                if (!isPumpSwapSwap(ix.data)) continue;
                leg = decodePumpSwapInstruction(ix, parsed.accountKeys);
            } else if (pubkeyMatch(programId, RAYDIUMV4_BYTES)) {
                if (!isRaydiumV4Swap(ix.data)) continue;
                leg = decodeRaydiumV4Instruction(ix, parsed.accountKeys);
            }

            if (!leg) continue;

            stats.swapsDetected++;
            processLeg(leg, update);
        }
    }

    function processLeg(leg: SwapLeg, update: TxUpdate): void {
        // Look up pool in L1 cache
        const poolEntry = config.poolCache.get(leg.pool);
        if (!poolEntry) return;

        const pool = poolEntry.state;
        const venue = pool.venue;

        // Only handle CPMM venues
        if (venue !== VenueId.PumpSwap && venue !== VenueId.RaydiumV4) return;

        // Look up vault balances
        const baseVault = (pool as PumpSwapPool | RaydiumV4Pool).baseVault;
        const quoteVault = (pool as PumpSwapPool | RaydiumV4Pool).quoteVault;
        const baseVaultEntry = config.vaultCache.get(baseVault);
        const quoteVaultEntry = config.vaultCache.get(quoteVault);
        if (!baseVaultEntry || !quoteVaultEntry) return;

        // Enrich pool with reserves + fees (venue-specific)
        let enrichedPool: EnrichedPool;
        if (venue === VenueId.PumpSwap) {
            enrichedPool = enrichPumpSwapPool(
                pool as PumpSwapPool,
                baseVaultEntry.amount,
                quoteVaultEntry.amount,
            );
        } else {
            enrichedPool = enrichRaydiumV4Pool(
                pool as RaydiumV4Pool,
                baseVaultEntry.amount,
                quoteVaultEntry.amount,
            );
        }

        // Validate reserves are positive
        if (enrichedPool.baseReserve <= 0n || enrichedPool.quoteReserve <= 0n) return;

        const totalFeeBps = enrichedPool.lpFeeBps + enrichedPool.protocolFeeBps;

        // Determine victim's actual input amount
        let victimInput: bigint;

        if (leg.exactSide === 'output') {
            const reserves = leg.direction === SwapDirection.BtoA
                ? { reserveIn: enrichedPool.quoteReserve, reserveOut: enrichedPool.baseReserve }
                : { reserveIn: enrichedPool.baseReserve, reserveOut: enrichedPool.quoteReserve };
            victimInput = getAmountIn(
                leg.minOutputAmount,
                reserves.reserveIn,
                reserves.reserveOut,
                totalFeeBps,
            );
            if (victimInput <= 0n || victimInput > leg.inputAmount) {
                victimInput = leg.inputAmount;
            }
        } else {
            victimInput = leg.inputAmount;
        }

        // Simulate victim swap
        const victimResult = simulateConstantProduct({
            pool: leg.pool,
            venue,
            direction: leg.direction,
            inputAmount: victimInput,
            poolState: enrichedPool,
        });

        if (!victimResult.success) return;

        // ====================================================================
        // Round-trip backrun: always start and end in SOL (quote side)
        //
        // For SOL-paired pools (base=token, quote=SOL):
        //   BtoA = SOL→token (buy), AtoB = token→SOL (sell)
        //
        // Our round-trip must be SOL-in → SOL-out:
        //   Swap1: BtoA (SOL→token) — enter position
        //   Swap2: AtoB (token→SOL) — close position
        //
        // We profit when the victim's swap created a price dislocation
        // that we can exploit by trading in the opposite direction.
        //
        // For victim BtoA (buy token): price goes up → we buy BEFORE is not
        //   possible (backrun), so we sell token (AtoB) at inflated price.
        //   But we need tokens to sell → this is actually:
        //   We need the round-trip where candidateInput is SOL:
        //     Swap1: BtoA (SOL→token) on post-victim state
        //     Swap2: AtoB (token→SOL) on post-swap1 state
        //   Profit = swap2 SOL out - candidateInput SOL in
        //
        // For victim AtoB (sell token): price goes down → we buy cheap:
        //     Swap1: BtoA (SOL→token) on post-victim state — get cheap tokens
        //     Swap2: AtoB (token→SOL) on post-swap1 state — sell tokens
        //   Same round-trip direction regardless of victim direction.
        //
        // The key insight: our round-trip is ALWAYS BtoA then AtoB.
        // SIZE_CANDIDATES are always in SOL lamports.
        // Profit is always in SOL lamports.
        // ====================================================================

        const ourDir1 = SwapDirection.BtoA; // SOL → token (enter)
        const ourDir2 = SwapDirection.AtoB; // token → SOL (close)

        // Try candidate sizes, pick max profit
        let bestProfit = -1n;
        let bestInput = 0n;
        let bestSwap1Out = 0n;
        let bestSwap2Out = 0n;

        for (const candidateInput of SIZE_CANDIDATES) {
            // Skip if candidate exceeds quote reserve (can't buy more than exists)
            if (candidateInput >= (victimResult.newPoolState as PumpSwapPool | RaydiumV4Pool).quoteReserve!) continue;

            // Swap 1: SOL → token (BtoA) on post-victim state
            const swap1 = simulateConstantProduct({
                pool: leg.pool,
                venue,
                direction: ourDir1,
                inputAmount: candidateInput,
                poolState: victimResult.newPoolState,
            });
            if (!swap1.success || swap1.outputAmount === 0n) continue;

            // Swap 2: token → SOL (AtoB) on post-swap1 state
            const swap2 = simulateConstantProduct({
                pool: leg.pool,
                venue,
                direction: ourDir2,
                inputAmount: swap1.outputAmount,
                poolState: swap1.newPoolState,
            });
            if (!swap2.success || swap2.outputAmount === 0n) continue;

            // Profit = SOL out - SOL in (both in lamports, same denomination)
            const grossProfit = swap2.outputAmount - candidateInput;
            if (grossProfit > bestProfit) {
                bestProfit = grossProfit;
                bestInput = candidateInput;
                bestSwap1Out = swap1.outputAmount;
                bestSwap2Out = swap2.outputAmount;
            }
        }

        if (bestProfit <= 0n) return;

        // Net profit after gas + tip (all in SOL lamports)
        const netProfit = bestProfit - gasCostLamports - config.tipLamports;
        if (netProfit < config.minProfitLamports) return;

        stats.opportunitiesFound++;

        // Apply slippage tolerance to min outputs
        const slippageMul = BigInt(10000 - config.slippageBps);
        const minOut1 = bestSwap1Out * slippageMul / 10000n;
        const minOut2 = bestSwap2Out * slippageMul / 10000n;

        // Build swap params
        const swap1Params: SwapParams = {
            direction: ourDir1,
            inputAmount: bestInput,
            minOutput: minOut1,
            pool: enrichedPool,
        };

        const swap2Params: SwapParams = {
            direction: ourDir2,
            inputAmount: bestSwap1Out,
            minOutput: minOut2,
            pool: enrichedPool,
        };

        // Reconstruct victim raw tx for bundle inclusion
        // Format: [compactU16(1), signature(64), message]
        const victimTxBytes = new Uint8Array(1 + 64 + update.message.length);
        victimTxBytes[0] = 1; // 1 signature
        victimTxBytes.set(update.signature, 1);
        victimTxBytes.set(update.message, 65);

        // Build bundle
        const result = buildBundle(
            swap1Params,
            swap2Params,
            config.payerKeypair,
            bundleConfig,
            config.getRecentBlockhash(),
            victimTxBytes,
        );

        if (!result.success || !result.bundle) return;

        stats.bundlesBuilt++;

        if (config.dryRun) {
            // Dry-run: log opportunity details without submitting
            stats.bundlesSubmitted++;
            stats.totalProfitLamports += netProfit;
            console.log(
                `[backrun:dry] venue=${venue === VenueId.PumpSwap ? 'PumpSwap' : 'RaydiumV4'} ` +
                `profit=${(Number(netProfit) / 1e9).toFixed(6)}SOL ` +
                `input=${(Number(bestInput) / 1e9).toFixed(3)}SOL ` +
                `swap1out=${bestSwap1Out} swap2out=${bestSwap2Out} ` +
                `latency=${result.buildLatencyUs.toFixed(0)}us`,
            );
            return;
        }

        // Fire-and-forget submission
        config.jitoClient.submitWithRetry(result.bundle).then(submitResult => {
            if (submitResult.submitted) {
                stats.bundlesSubmitted++;
                stats.totalProfitLamports += netProfit;
                if (process.env.DEBUG) {
                    console.log(
                        `[backrun] SUBMITTED bundle=${submitResult.bundleId} ` +
                        `venue=${venue === VenueId.PumpSwap ? 'PS' : 'RV4'} ` +
                        `profit=${(Number(netProfit) / 1e9).toFixed(6)}SOL ` +
                        `input=${(Number(bestInput) / 1e9).toFixed(3)}SOL ` +
                        `latency=${result.buildLatencyUs.toFixed(0)}us`,
                    );
                }
            }
        }).catch(() => {
            // Submission errors already tracked in JitoClient stats
        });
    }

    return {
        handleShredEvent,
        getStats: (): BackrunStats => ({ ...stats }),
    };
}
