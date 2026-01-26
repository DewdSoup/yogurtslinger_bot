// src/ingest.ts v2.3 - HYBRID VAULT SUBSCRIPTION (CORRECT FIX)
// UNIFIED ENTRY POINT - Geyser → Decode → Cache → ArbBrain → SimGate → Jito
//
// v2.3 CHANGES (Dec 2024):
// - ✅ FIX: HYBRID vault subscription approach:
//   1. Owner-based subscription to TOKEN_PROGRAM_ID for INITIAL SNAPSHOT
//   2. Dynamic account-based subscription for LIVE UPDATES
//   This fixes both the "no initial state" and "no live updates" issues
//
// OPTIMIZATIONS (Dec 2024):
// 1. ✅ ArbBrain wired to cache updates
// 2. ✅ Async snapshot writer (non-blocking)
// 3. ✅ Batch message processing
// 4. ✅ Reduced allocations in hot path
// 5. ✅ Pre-computed PublicKey constants
// 6. ✅ Hybrid vault subscription (CORRECT fix for stale cache)
//
// RUN: export WALLET_PATH="/home/sol/keys/yogurtslinger-hot.json"; pnpm run ingest

import { createRequire } from "node:module";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
    MarketCache,
    markInitialSyncComplete,
    isInitialSyncComplete,
    resetInitialSyncState
} from "./brain/marketCache.js";
import { decodePumpAccount } from "./decoders/pump.js";
import {
    decodeRaydiumPool,
    decodeCLMMPool,
    isCLMMPool,
    CLMM_POOL_SIZE,
    V4_POOL_SIZE,
} from "./decoders/raydium.js";
import {
    decodePumpSwapPool,
    isPumpSwapPoolAccount
} from "./decoders/pumpswap.js";
import {
    decodeMeteoraLbPair,
    isMeteoraLbPairAccount,
    computeMeteoraPrice,
    computeMeteoraFeeFromState,
    isTradeableMeteoraPool
} from "./decoders/meteora.js";
import {
    decodeTokenAccountBalance,
    isTokenAccount
} from "./decoders/token_account.js";
import { computePumpPrice } from "./brain/pricing.js";
import { ArbBrain } from "./brain/arbBrain.js";
import { binTracker } from "./ingest/binTracker.js";
import {
    meteoraEdge,
    type FeeDecayOpportunity,
    type BackrunOpportunity,
} from "./signals/meteoraEdge.js";
import type { EngineConfig } from "./execution/executionEngine.js";
import type { CapitalConfig } from "./execution/positionSizer.js";
import {
    fragmentationTracker,
    type FragmentationEvent
} from "./brain/fragmentationTracker.js";

const require = createRequire(import.meta.url);

// =============================================================================
// RUN DIRECTORY SETUP - All logs go here
// =============================================================================

const RUNS_BASE = path.resolve(process.cwd(), "src", "data", "runs");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(RUNS_BASE, RUN_ID);

// =============================================================================
// CONFIGURATION
// =============================================================================

const GEYSER_ENDPOINT = process.env.GEYSER_ENDPOINT ?? "http://127.0.0.1:10000";
const RPC_ENDPOINT = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const WALLET_PATH = process.env.WALLET_PATH ?? "/home/sol/keys/yogurtslinger-hot.json";
const JITO_ENDPOINT = process.env.JITO_ENDPOINT ?? "https://mainnet.block-engine.jito.wtf";

const DRY_RUN = process.env.DRY_RUN !== "false";
const PAPER_TRADE = process.env.PAPER_TRADE === "true";
const MIN_CANDIDATE_SPREAD_BPS = parseInt(process.env.MIN_SPREAD_BPS ?? "55", 10);
const MAX_TRADE_SOL = parseFloat(process.env.MAX_TRADE_SOL ?? "0.5");
const TOTAL_CAPITAL_SOL = parseFloat(process.env.TOTAL_CAPITAL_SOL ?? "2.0");

// Stream health
const STREAM_HEALTH_CHECK_MS = 10000;
const STREAM_STALL_THRESHOLD_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1000;

// =============================================================================
// PRE-COMPUTED CONSTANTS (avoid allocation in hot path)
// =============================================================================

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const RAYDIUM_AMM_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Pre-computed PublicKeys for owner comparison
const PUMP_PROGRAM_PK = new PublicKey(PUMP_PROGRAM_ID);
const RAYDIUM_AMM_PK = new PublicKey(RAYDIUM_AMM_PROGRAM_ID);
const RAYDIUM_CLMM_PK = new PublicKey(RAYDIUM_CLMM_PROGRAM_ID);
const PUMPSWAP_PK = new PublicKey(PUMPSWAP_PROGRAM_ID);
const METEORA_DLMM_PK = new PublicKey(METEORA_DLMM_PROGRAM_ID);
const TOKEN_PROGRAM_PK = new PublicKey(TOKEN_PROGRAM_ID);

// Owner bytes for fast comparison (avoid PublicKey allocation)
const PUMP_OWNER_BYTES = PUMP_PROGRAM_PK.toBytes();
const RAYDIUM_AMM_OWNER_BYTES = RAYDIUM_AMM_PK.toBytes();
const RAYDIUM_CLMM_OWNER_BYTES = RAYDIUM_CLMM_PK.toBytes();
const PUMPSWAP_OWNER_BYTES = PUMPSWAP_PK.toBytes();
const METEORA_OWNER_BYTES = METEORA_DLMM_PK.toBytes();
const TOKEN_OWNER_BYTES = TOKEN_PROGRAM_PK.toBytes();

const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
const NATIVE_SOL_MINT_STR = "11111111111111111111111111111111";
const USDC_MINT_STR = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT_STR = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const PUMPSWAP_FEE = 0.0030;
const RAYDIUM_V4_FEE = 0.0025;
const MAX_METEORA_FEE_FOR_ARB = 0.20;

// =============================================================================
// FAST BYTE COMPARISON (avoid string conversion in hot path)
// =============================================================================

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// =============================================================================
// MINT CLASSIFICATION (inlined for speed)
// =============================================================================

function isSolMint(mint: string): boolean {
    return mint === SOL_MINT_STR || mint === NATIVE_SOL_MINT_STR;
}

function isStablecoin(mint: string): boolean {
    return mint === USDC_MINT_STR || mint === USDT_MINT_STR;
}

function isMemecoin(mint: string): boolean {
    return !isSolMint(mint) && !isStablecoin(mint);
}

function isValidMeteoraQuote(mint: string): boolean {
    return isSolMint(mint) || isStablecoin(mint);
}

function getQuoteType(mint: string): "SOL" | "USDC" | "USDT" | "UNKNOWN" {
    if (isSolMint(mint)) return "SOL";
    if (mint === USDC_MINT_STR) return "USDC";
    if (mint === USDT_MINT_STR) return "USDT";
    return "UNKNOWN";
}

// =============================================================================
// YELLOWSTONE LOADER
// =============================================================================

function loadYellowstone(): any {
    const candidates = [
        "@triton-one/yellowstone-grpc/dist/cjs",
        "@triton-one/yellowstone-grpc/dist/cjs/index.js",
        "@triton-one/yellowstone-grpc/dist/commonjs",
        "@triton-one/yellowstone-grpc/dist/commonjs/index.js",
        "@triton-one/yellowstone-grpc"
    ];

    for (const id of candidates) {
        try {
            return require(id);
        } catch {
            // Try next
        }
    }
    throw new Error("Failed to load @triton-one/yellowstone-grpc");
}

type SubscribeUpdate = any;

// =============================================================================
// STATE
// =============================================================================

const DECODE_ERROR_LOG_LIMIT = 20;
let decodeErrorCount = 0;
let totalMessagesProcessed = 0;
let messagesThisInterval = 0;

let initialSyncMessageCount = 0;
const INITIAL_SYNC_THRESHOLD = 1000;
let lastMessageBurstTs = Date.now();
const BURST_TIMEOUT_MS = 3000;

// SNAPSHOT FILE NOW IN RUN_DIR
const SNAPSHOT_FILE = path.join(RUN_DIR, "markets_snapshot.json");
const SNAPSHOT_INTERVAL_MS = 10000;
const SNAPSHOT_ENABLED = process.env.DISABLE_SNAPSHOT !== "1";

const SUMMARY_INTERVAL_MS = 5000;

// ✅ FIX: trackedVaults - vaults we want to track (populated from pool discovery)
// This is used to FILTER which token accounts we actually cache
const trackedVaults = new Set<string>();

// ✅ FIX: subscribedVaults - vaults we've explicitly subscribed to for LIVE updates
// This is separate from trackedVaults because we get initial state from owner-based subscription
const subscribedVaults = new Set<string>();
let pendingVaultSubscriptions: string[] = [];
let vaultSubscriptionScheduled = false;
let vaultSubscriptionCount = 0;

let solUsdPrice = 0;
let lastSolUsdUpdate = 0;

let meteoraPoolsWithHighFees = 0;
let meteoraPoolsWithLowFees = 0;

const START_TS = Date.now();
const DEBUG_INGEST = process.env.INGEST_DEBUG === "1";
const VERBOSE_HOT_PATH = process.env.VERBOSE_HOT_PATH === "1";

// Debug flags (only log once)
let raydiumV4DebugLogged = false;
let raydiumClmmDebugLogged = false;
let meteoraDebugLogged = false;

// Stream state
let yellowstoneModule: any = null;
let geyserClient: any = null;
let geyserStream: any = null;
let subscriptionRequest: any = null;
let reconnectAttempts = 0;
let lastMessageTs = Date.now();
let isShuttingDown = false;

// BinArray subscription
const subscribedBinArrays = new Set<string>();
const poolActiveIds = new Map<string, number>();
let binArraySubscriptionCount = 0;

// =============================================================================
// ARBRAIN REFERENCE (for hot path triggering)
// =============================================================================

let arbBrainRef: ArbBrain | null = null;

// =============================================================================
// BATCH PROCESSING QUEUE
// =============================================================================

interface PendingUpdate {
    ownerBytes: Uint8Array;
    pubkeyBytes: Uint8Array;
    dataBytes: Uint8Array;
    slot: number;
}

const updateQueue: PendingUpdate[] = [];
const BATCH_SIZE = 50;
const BATCH_FLUSH_MS = 5;
let lastBatchFlush = Date.now();
let batchFlushScheduled = false;

function scheduleBatchFlush(cache: MarketCache): void {
    if (batchFlushScheduled) return;
    batchFlushScheduled = true;

    setImmediate(() => {
        batchFlushScheduled = false;
        processBatch(cache);
    });
}

function processBatch(cache: MarketCache): void {
    if (updateQueue.length === 0) return;

    const batch = updateQueue.splice(0, Math.min(updateQueue.length, BATCH_SIZE));
    const tokenMintsTouched = new Set<string>();

    for (const update of batch) {
        const touchedMint = processAccountUpdate(update, cache);
        if (touchedMint) {
            tokenMintsTouched.add(touchedMint);
        }
    }

    // Trigger ArbBrain for touched tokens that are ALREADY fragmented
    // (NEW_FRAGMENTATION events are handled separately by the tracker subscription)
    if (arbBrainRef && tokenMintsTouched.size > 0 && isInitialSyncComplete()) {
        for (const mint of tokenMintsTouched) {
            // Use FragmentationTracker for O(1) lookup instead of O(n) scan
            if (fragmentationTracker.isFragmented(mint)) {
                arbBrainRef.processTokenUpdate(mint).catch(() => { });
            }
        }
    }

    lastBatchFlush = Date.now();

    if (updateQueue.length > 0) {
        scheduleBatchFlush(cache);
    }
}

// =============================================================================
// ✅ FIX: DYNAMIC VAULT SUBSCRIPTION FOR LIVE UPDATES
// =============================================================================

/**
 * Subscribe to specific vault accounts for LIVE updates.
 * 
 * WHY HYBRID APPROACH:
 * - Owner-based subscription (TOKEN_PROGRAM_ID) gives us INITIAL SNAPSHOT
 *   but may not reliably stream all updates (too many accounts)
 * - Account-based subscription gives us LIVE UPDATES for specific vaults
 * - We use BOTH: owner-based for initial state, account-based for live updates
 */
function subscribeToVaults(vaultAddresses: string[]): void {
    if (!geyserStream || !subscriptionRequest) return;

    const newVaults: string[] = [];
    for (const vault of vaultAddresses) {
        if (!subscribedVaults.has(vault)) {
            newVaults.push(vault);
            subscribedVaults.add(vault);
        }
    }

    if (newVaults.length === 0) return;

    pendingVaultSubscriptions.push(...newVaults);

    if (!vaultSubscriptionScheduled) {
        vaultSubscriptionScheduled = true;
        setTimeout(() => { flushVaultSubscriptions(); }, 100);
    }
}

function flushVaultSubscriptions(): void {
    vaultSubscriptionScheduled = false;

    if (pendingVaultSubscriptions.length === 0) return;
    if (!geyserStream || !subscriptionRequest) return;

    const toSubscribe = pendingVaultSubscriptions.splice(0, pendingVaultSubscriptions.length);

    // Add to the dynamic vaults subscription
    subscriptionRequest.accounts.vaultsDynamic.account.push(...toSubscribe);

    geyserStream.write(subscriptionRequest, (err: unknown) => {
        if (err) {
            for (const addr of toSubscribe) {
                subscribedVaults.delete(addr);
            }
            console.error(`[ingest] Vault subscription failed for ${toSubscribe.length} vaults:`, err);
        } else {
            vaultSubscriptionCount += toSubscribe.length;
            if (VERBOSE_HOT_PATH) {
                console.log(`[VAULT] +${toSubscribe.length} subscribed [total: ${subscribedVaults.size}]`);
            }
        }
    });
}

// =============================================================================
// ACCOUNT UPDATE PROCESSOR (returns tokenMint if price-affecting)
// =============================================================================

function processAccountUpdate(update: PendingUpdate, cache: MarketCache): string | null {
    const { ownerBytes, pubkeyBytes, dataBytes, slot } = update;

    let pubkey: string;

    try {
        if (bytesEqual(ownerBytes, PUMP_OWNER_BYTES)) {
            pubkey = new PublicKey(pubkeyBytes).toBase58();
            const decoded = decodePumpAccount(Buffer.from(dataBytes));
            cache.upsertPumpCurve(pubkey, slot, decoded);
            return null;

        } else if (bytesEqual(ownerBytes, RAYDIUM_AMM_OWNER_BYTES)) {
            if (dataBytes.length !== V4_POOL_SIZE) return null;
            pubkey = new PublicKey(pubkeyBytes).toBase58();

            const decoded = decodeRaydiumPool(Buffer.from(dataBytes));
            const baseVault = decoded.baseVault?.toBase58() ?? null;
            const quoteVault = decoded.quoteVault?.toBase58() ?? null;

            // Track vaults and subscribe for live updates
            const vaultsToSubscribe: string[] = [];
            if (baseVault) {
                trackedVaults.add(baseVault);
                vaultsToSubscribe.push(baseVault);
            }
            if (quoteVault) {
                trackedVaults.add(quoteVault);
                vaultsToSubscribe.push(quoteVault);
            }
            if (vaultsToSubscribe.length > 0) {
                subscribeToVaults(vaultsToSubscribe);
            }

            if (DEBUG_INGEST && !raydiumV4DebugLogged) {
                console.log(`[RAY V4] Sample: ${pubkey.slice(0, 8)} baseVault=${baseVault?.slice(0, 8)}`);
                raydiumV4DebugLogged = true;
            }

            cache.upsertRaydiumPool(pubkey, slot, decoded);

            const baseMint = decoded.baseMint.toBase58();
            const quoteMint = decoded.quoteMint.toBase58();

            // Track venue for fragmentation detection
            let tokenMint: string | null = null;
            if (isSolMint(baseMint) && isMemecoin(quoteMint)) {
                tokenMint = quoteMint;
                fragmentationTracker.recordVenue(quoteMint, "raydiumV4", pubkey, BigInt(slot));
            } else if (isSolMint(quoteMint) && isMemecoin(baseMint)) {
                tokenMint = baseMint;
                fragmentationTracker.recordVenue(baseMint, "raydiumV4", pubkey, BigInt(slot));
            }

            return tokenMint;

        } else if (bytesEqual(ownerBytes, RAYDIUM_CLMM_OWNER_BYTES)) {
            if (dataBytes.length !== CLMM_POOL_SIZE) return null;
            if (!isCLMMPool(Buffer.from(dataBytes))) return null;

            pubkey = new PublicKey(pubkeyBytes).toBase58();
            const poolPk = new PublicKey(pubkeyBytes);
            const decoded = decodeCLMMPool(poolPk, Buffer.from(dataBytes), slot);
            if (!decoded) return null;

            const vault0 = decoded.tokenVault0.toBase58();
            const vault1 = decoded.tokenVault1.toBase58();

            trackedVaults.add(vault0);
            trackedVaults.add(vault1);
            subscribeToVaults([vault0, vault1]);

            if (DEBUG_INGEST && !raydiumClmmDebugLogged) {
                console.log(`[RAY CLMM] Sample: ${pubkey.slice(0, 8)} tick=${decoded.tickCurrent}`);
                raydiumClmmDebugLogged = true;
            }

            cache.upsertRaydiumCLMMPool(pubkey, slot, decoded);

            const mint0 = decoded.tokenMint0.toBase58();
            const mint1 = decoded.tokenMint1.toBase58();

            // Track venue for fragmentation detection
            let tokenMint: string | null = null;
            if (isSolMint(mint0) && isMemecoin(mint1)) {
                tokenMint = mint1;
                fragmentationTracker.recordVenue(mint1, "raydiumClmm", pubkey, BigInt(slot));
            } else if (isSolMint(mint1) && isMemecoin(mint0)) {
                tokenMint = mint0;
                fragmentationTracker.recordVenue(mint0, "raydiumClmm", pubkey, BigInt(slot));
            }

            return tokenMint;

        } else if (bytesEqual(ownerBytes, PUMPSWAP_OWNER_BYTES)) {
            if (!isPumpSwapPoolAccount(Buffer.from(dataBytes))) return null;
            pubkey = new PublicKey(pubkeyBytes).toBase58();

            const decoded = decodePumpSwapPool(Buffer.from(dataBytes));
            const baseVault = decoded.poolBaseTokenAccount.toBase58();
            const quoteVault = decoded.poolQuoteTokenAccount.toBase58();

            trackedVaults.add(baseVault);
            trackedVaults.add(quoteVault);
            subscribeToVaults([baseVault, quoteVault]);

            const existingPool = cache.getPumpSwapPool(pubkey);
            if (!existingPool && isInitialSyncComplete() && VERBOSE_HOT_PATH) {
                console.log(`[PS] 🆕 NEW pool: ${pubkey.slice(0, 8)} slot=${slot}`);
            }

            cache.upsertPumpSwapPool(pubkey, slot, decoded);

            const baseMint = decoded.baseMint.toBase58();
            const quoteMint = decoded.quoteMint.toBase58();

            // Track venue for fragmentation detection
            // PumpSwap is where tokens graduate from Pump.fun bonding curve
            let tokenMint: string | null = null;
            if (isSolMint(baseMint) && isMemecoin(quoteMint)) {
                tokenMint = quoteMint;
                fragmentationTracker.recordVenue(quoteMint, "pumpSwap", pubkey, BigInt(slot));
            } else if (isSolMint(quoteMint) && isMemecoin(baseMint)) {
                tokenMint = baseMint;
                fragmentationTracker.recordVenue(baseMint, "pumpSwap", pubkey, BigInt(slot));
            }

            return tokenMint;

        } else if (bytesEqual(ownerBytes, METEORA_OWNER_BYTES)) {
            pubkey = new PublicKey(pubkeyBytes).toBase58();

            if (subscribedBinArrays.has(pubkey)) {
                return null;
            }

            if (!isMeteoraLbPairAccount(Buffer.from(dataBytes))) return null;

            const decoded = decodeMeteoraLbPair(Buffer.from(dataBytes));
            const reserveX = decoded.reserveX.toBase58();
            const reserveY = decoded.reserveY.toBase58();

            trackedVaults.add(reserveX);
            trackedVaults.add(reserveY);
            subscribeToVaults([reserveX, reserveY]);

            const previousActiveId = poolActiveIds.get(pubkey);
            const currentActiveId = decoded.activeId;

            if (previousActiveId === undefined || previousActiveId !== currentActiveId) {
                poolActiveIds.set(pubkey, currentActiveId);
                if (isTradeableMeteoraPool(decoded, MAX_METEORA_FEE_FOR_ARB)) {
                    subscribeToBinArrays(pubkey, currentActiveId);
                }
            }

            if (DEBUG_INGEST && !meteoraDebugLogged) {
                const tokenX = decoded.tokenXMint.toBase58();
                const tokenY = decoded.tokenYMint.toBase58();
                console.log(`[MET] Sample: ${pubkey.slice(0, 8)} X=${tokenX.slice(0, 8)} Y=${tokenY.slice(0, 8)}`);
                meteoraDebugLogged = true;
            }

            cache.upsertMeteoraPool(pubkey, slot, decoded);

            const tokenXMint = decoded.tokenXMint.toBase58();
            const tokenYMint = decoded.tokenYMint.toBase58();
            const edgeTokenMint = isValidMeteoraQuote(tokenXMint) ? tokenYMint : tokenXMint;

            const handlers = (globalThis as any).__meteoraEdgeHandlers;
            if (handlers) {
                meteoraEdge.trackUpdate(
                    pubkey,
                    decoded,
                    BigInt(slot),
                    edgeTokenMint,
                    {
                        onFeeDecay: handlers.onFeeDecay,
                        onBackrun: handlers.onBackrun,
                    }
                );
            }

            const xIsQuote = isValidMeteoraQuote(tokenXMint);
            const yIsQuote = isValidMeteoraQuote(tokenYMint);

            // Track venue for fragmentation detection
            let tokenMint: string | null = null;
            if (xIsQuote && isMemecoin(tokenYMint)) {
                tokenMint = tokenYMint;
                fragmentationTracker.recordVenue(tokenYMint, "meteora", pubkey, BigInt(slot));
            } else if (yIsQuote && isMemecoin(tokenXMint)) {
                tokenMint = tokenXMint;
                fragmentationTracker.recordVenue(tokenXMint, "meteora", pubkey, BigInt(slot));
            }

            return tokenMint;

        } else if (bytesEqual(ownerBytes, TOKEN_OWNER_BYTES)) {
            pubkey = new PublicKey(pubkeyBytes).toBase58();

            // ✅ FIX: Process token accounts if they're in trackedVaults
            // This works because:
            // 1. Owner-based subscription gives us initial state for ALL token accounts
            // 2. We filter to only cache those in trackedVaults (discovered from pools)
            // 3. Dynamic subscription ensures we get LIVE updates for those same vaults
            if (trackedVaults.has(pubkey) && isTokenAccount(Buffer.from(dataBytes))) {
                const balance = decodeTokenAccountBalance(Buffer.from(dataBytes));
                cache.getTokenAccountCache().upsert(pubkey, balance, BigInt(slot));

                if (VERBOSE_HOT_PATH) {
                    console.log(`[VAULT] 💰 ${pubkey.slice(0, 8)}... balance=${balance} slot=${slot}`);
                }
            }
            return null;
        }
    } catch (e) {
        if (decodeErrorCount < DECODE_ERROR_LOG_LIMIT) {
            const pk = pubkeyBytes ? new PublicKey(pubkeyBytes).toBase58() : "unknown";
            console.error(`[ingest] Decode error ${pk}: ${(e as Error).message}`);
            decodeErrorCount++;
        }
    }

    return null;
}

// =============================================================================
// STREAM HANDLERS
// =============================================================================

function attachStreamHandlers(stream: any, cache: MarketCache): void {
    stream.on("data", (update: SubscribeUpdate) => {
        totalMessagesProcessed++;
        messagesThisInterval++;
        initialSyncMessageCount++;
        lastMessageBurstTs = Date.now();
        lastMessageTs = Date.now();

        const accountUpdate = (update as any).account;
        if (!accountUpdate?.account) return;

        const rawAccount = accountUpdate.account;
        const ownerBytes: Uint8Array | undefined = rawAccount.owner;
        const pubkeyBytes: Uint8Array | undefined = rawAccount.pubkey;
        const dataBytes: Uint8Array | undefined = rawAccount.data;

        if (!ownerBytes || !pubkeyBytes || !dataBytes) return;

        const slot = Number(accountUpdate.slot ?? 0);

        updateQueue.push({ ownerBytes, pubkeyBytes, dataBytes, slot });

        if (updateQueue.length >= BATCH_SIZE || Date.now() - lastBatchFlush > BATCH_FLUSH_MS) {
            scheduleBatchFlush(cache);
        }
    });
}

// =============================================================================
// BINARRAY SUBSCRIPTION
// =============================================================================

function subscribeToBinArrays(pairPubkey: string, activeId: number): void {
    if (!geyserStream || !subscriptionRequest) return;

    try {
        const pairPk = new PublicKey(pairPubkey);
        const pdas = binTracker.getSubscriptionPdas(activeId, pairPk);
        const newPdas: { index: bigint; pda: PublicKey }[] = [];

        for (const { index, pda } of pdas) {
            const pdaStr = pda.toBase58();
            if (!subscribedBinArrays.has(pdaStr)) {
                newPdas.push({ index, pda });
                subscribedBinArrays.add(pdaStr);
            }
        }

        if (newPdas.length === 0) return;

        const newAddresses = newPdas.map(p => p.pda.toBase58());
        subscriptionRequest.accounts.binArrays.account.push(...newAddresses);

        geyserStream.write(subscriptionRequest, (err: unknown) => {
            if (err) {
                for (const addr of newAddresses) {
                    subscribedBinArrays.delete(addr);
                }
            }
        });

        binArraySubscriptionCount += newPdas.length;

        if (VERBOSE_HOT_PATH) {
            console.log(`[BIN] +${newPdas.length} arrays for ${pairPubkey.slice(0, 8)} [total: ${subscribedBinArrays.size}]`);
        }
    } catch {
        // Silent fail in hot path
    }
}

// =============================================================================
// STREAM HEALTH MONITOR
// =============================================================================

function startStreamHealthMonitor(cache: MarketCache): void {
    setInterval(() => {
        if (isShuttingDown) return;

        const timeSinceLastMessage = Date.now() - lastMessageTs;

        if (timeSinceLastMessage > STREAM_STALL_THRESHOLD_MS) {
            console.error(`[ingest] ⚠️ STREAM STALL: No messages for ${Math.round(timeSinceLastMessage / 1000)}s`);

            if (geyserStream) {
                try { geyserStream.end(); } catch { }
                geyserStream = null;
            }

            reconnectWithBackoff(cache).catch((err) => {
                console.error("[ingest] Reconnection failed:", err);
            });
        }
    }, STREAM_HEALTH_CHECK_MS);
}

// =============================================================================
// RECONNECTION
// =============================================================================

async function reconnectWithBackoff(cache: MarketCache): Promise<void> {
    if (isShuttingDown) return;

    reconnectAttempts++;

    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(`[ingest] Max reconnect attempts exceeded. Exiting.`);
        process.exit(1);
    }

    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
    console.log(`[ingest] Reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
        await connectGeyserStream(cache);
        reconnectAttempts = 0;
        console.log("[ingest] ✅ Reconnected");
    } catch (err) {
        console.error(`[ingest] Reconnect failed:`, err);
    }
}

// =============================================================================
// GEYSER CONNECTION
// =============================================================================

async function connectGeyserStream(cache: MarketCache): Promise<void> {
    const ClientCtor = yellowstoneModule.Client ?? yellowstoneModule.default ?? yellowstoneModule;
    geyserClient = new ClientCtor(GEYSER_ENDPOINT, process.env.X_TOKEN, {});

    console.log("[ingest] Opening Yellowstone stream...");
    const stream: any = await geyserClient.subscribe();

    if (!stream) throw new Error("Failed to open gRPC stream");

    geyserStream = stream;

    stream.on("error", (err: unknown) => {
        console.error("[ingest] Stream error:", err);
        if (!isShuttingDown) lastMessageTs = 0;
    });

    stream.on("end", () => {
        console.log("[ingest] Stream ended");
        if (!isShuttingDown) lastMessageTs = 0;
    });

    const CommitmentLevel = yellowstoneModule.CommitmentLevel;

    // ✅ FIX: HYBRID SUBSCRIPTION
    // 1. tokenAccounts (owner-based) - gives INITIAL SNAPSHOT of all token accounts
    // 2. vaultsDynamic (account-based) - gives LIVE UPDATES for specific vaults
    subscriptionRequest = {
        accounts: {
            pump: { account: [], owner: [PUMP_PROGRAM_ID], filters: [] },
            raydiumV4: { account: [], owner: [RAYDIUM_AMM_PROGRAM_ID], filters: [] },
            raydiumClmm: { account: [], owner: [RAYDIUM_CLMM_PROGRAM_ID], filters: [] },
            pumpswap: { account: [], owner: [PUMPSWAP_PROGRAM_ID], filters: [] },
            meteora: { account: [], owner: [METEORA_DLMM_PROGRAM_ID], filters: [] },
            binArrays: { account: [] as string[], owner: [], filters: [] },
            // ✅ Owner-based for INITIAL SNAPSHOT (may not get all live updates)
            tokenAccounts: { account: [], owner: [TOKEN_PROGRAM_ID], filters: [] },
            // ✅ Account-based for LIVE UPDATES (dynamically populated)
            vaultsDynamic: { account: [] as string[], owner: [], filters: [] }
        },
        slots: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        ping: undefined,
        commitment: CommitmentLevel?.PROCESSED ?? undefined
    };

    // Re-subscribe on reconnect
    if (subscribedBinArrays.size > 0) {
        subscriptionRequest.accounts.binArrays.account = Array.from(subscribedBinArrays);
    }

    if (subscribedVaults.size > 0) {
        subscriptionRequest.accounts.vaultsDynamic.account = Array.from(subscribedVaults);
        console.log(`[ingest] Re-subscribing to ${subscribedVaults.size} vaults for live updates`);
    }

    await new Promise<void>((resolve, reject) => {
        stream.write(subscriptionRequest, (err: unknown) => {
            if (err == null) resolve();
            else reject(err);
        });
    });

    attachStreamHandlers(stream, cache);
    lastMessageTs = Date.now();

    console.log("[ingest] ✅ Subscribed: Pump, RayV4, RayCLMM, PumpSwap, Meteora, TokenAccounts");
    console.log("[ingest] ✅ HYBRID vault subscription: owner-based (initial) + account-based (live)");
}

// =============================================================================
// INITIAL SYNC MONITOR
// =============================================================================

function attachInitialSyncMonitor(): void {
    const checkInterval = setInterval(() => {
        if (isInitialSyncComplete()) {
            clearInterval(checkInterval);
            return;
        }

        const timeSinceLastBurst = Date.now() - lastMessageBurstTs;

        if (initialSyncMessageCount > INITIAL_SYNC_THRESHOLD && timeSinceLastBurst > BURST_TIMEOUT_MS) {
            markInitialSyncComplete();
            console.log(`[ingest] ✅ Initial sync complete: ${initialSyncMessageCount} msgs`);
            console.log(`[ingest] ✅ Tracked vaults: ${trackedVaults.size}, Subscribed for live: ${subscribedVaults.size}, Cached: ${cache.getTokenAccountCache().size()}`);
            clearInterval(checkInterval);
        }
    }, 1000);
}

// Reference cache for initial sync monitor
let cache: MarketCache;

// =============================================================================
// SUMMARY LOGGER
// =============================================================================

function attachSummaryLogger(marketCache: MarketCache, arbBrain: ArbBrain): void {
    setInterval(() => {
        const tokenAccountCache = marketCache.getTokenAccountCache();
        const pumpSwapPools = marketCache.getAllPumpSwapPools();
        const raydiumV4Pools = marketCache.getAllRaydiumPools();
        const raydiumClmmPools = marketCache.getAllRaydiumCLMMPools();
        const meteoraPools = marketCache.getAllMeteoraPools();

        // Use FragmentationTracker for efficient stats (no full scan)
        const fragStats = fragmentationTracker.getSummary();
        const trackerStats = fragmentationTracker.getStats();

        const syncStatus = isInitialSyncComplete() ? "LIVE" : "SYNC";
        const solPriceStr = solUsdPrice > 0 ? `$${solUsdPrice.toFixed(0)}` : "?";
        const uptimeSec = Math.floor((Date.now() - START_TS) / 1000);

        const brainStats = arbBrain.getStats();
        const edgeStats = meteoraEdge.getStats();

        // Show tracked vs subscribed vs cached + fragmentation from tracker
        console.log(
            `[${syncStatus}] ${uptimeSec}s | ` +
            `msgs=${messagesThisInterval} | ` +
            `PS=${pumpSwapPools.length} RayV4=${raydiumV4Pools.length} CLMM=${raydiumClmmPools.length} Met=${meteoraPools.length} | ` +
            `Vaults: track=${trackedVaults.size} live=${subscribedVaults.size} cache=${tokenAccountCache.size()} | ` +
            `Frag: 2v=${fragStats.by2Venues} 3v=${fragStats.by3Venues} 4v=${fragStats.by4Venues} [${fragStats.fragmented}/${fragStats.total}] | ` +
            `Grad=${trackerStats.graduations} NewFrag=${trackerStats.newFragmentations} | ` +
            `SOL=${solPriceStr}`
        );

        console.log(
            `[ARB] cand=${brainStats.candidatesDetected} route=${brainStats.candidatesRouted} ` +
            `local=${brainStats.localSimApproved}/${brainStats.localSimRejected} ` +
            `recent1m=${fragStats.recentFragmentations}`
        );

        if (edgeStats.feeDecay.spikesDetected > 0 || edgeStats.emptyBin.movesDetected > 0) {
            console.log(
                `[EDGE] FeeDecay: spikes=${edgeStats.feeDecay.spikesDetected} opps=${edgeStats.feeDecay.activeOpportunities} | ` +
                `EmptyBin: moves=${edgeStats.emptyBin.movesDetected} backruns=${edgeStats.emptyBin.backrunOpportunities}`
            );
        }

        messagesThisInterval = 0;
    }, SUMMARY_INTERVAL_MS);
}

// =============================================================================
// ASYNC SNAPSHOT WRITER
// =============================================================================

let snapshotWriteInProgress = false;

function attachSnapshotWriter(marketCache: MarketCache): void {
    if (!SNAPSHOT_ENABLED) {
        console.log("[ingest] Snapshot writer: DISABLED");
        return;
    }

    const dir = path.dirname(SNAPSHOT_FILE);
    void fs.mkdir(dir, { recursive: true }).catch(() => { });

    const writeSnapshot = async () => {
        if (snapshotWriteInProgress) return;
        snapshotWriteInProgress = true;

        try {
            const tokenAccountCache = marketCache.getTokenAccountCache();
            const snapshot = buildSnapshotData(marketCache, tokenAccountCache);
            const jsonStr = JSON.stringify(snapshot);
            const tempFile = SNAPSHOT_FILE + ".tmp";
            await fs.writeFile(tempFile, jsonStr);
            await fs.rename(tempFile, SNAPSHOT_FILE);
        } catch (err) {
            if (DEBUG_INGEST) {
                console.error("[ingest] Snapshot write failed:", err);
            }
        } finally {
            snapshotWriteInProgress = false;
        }
    };

    setTimeout(() => { void writeSnapshot(); }, 5000);
    setInterval(() => { void writeSnapshot(); }, SNAPSHOT_INTERVAL_MS);
}

function buildSnapshotData(marketCache: MarketCache, tokenAccountCache: any): any {
    const pumpCurves = marketCache.getAllPumpCurves().map((entry) => {
        const priceView = computePumpPrice(entry.state);
        return {
            pubkey: entry.pubkey,
            slot: entry.slot.toString(),
            firstSeenTs: entry.firstSeenTs,
            lastUpdatedTs: entry.lastUpdatedTs,
            createdSlot: entry.createdSlot?.toString() ?? null,
            createdTs: entry.createdTs,
            detectedDuringSync: entry.detectedDuringSync,
            priceSolPerToken: priceView.priceSolPerToken,
            tokenMint: null as string | null
        };
    });

    const raydiumV4Pools = marketCache.getAllRaydiumPools().map((entry) => {
        const s = entry.state;
        const baseMint = s.baseMint.toBase58();
        const quoteMint = s.quoteMint.toBase58();
        const baseIsSol = isSolMint(baseMint);
        const quoteIsSol = isSolMint(quoteMint);

        let tokenMint: string | null = null;
        if (baseIsSol && isMemecoin(quoteMint)) tokenMint = quoteMint;
        else if (quoteIsSol && isMemecoin(baseMint)) tokenMint = baseMint;

        const baseVault = s.baseVault?.toBase58() ?? null;
        const quoteVault = s.quoteVault?.toBase58() ?? null;

        const baseVaultBalance = baseVault ? tokenAccountCache.getBalance(baseVault) : undefined;
        const quoteVaultBalance = quoteVault ? tokenAccountCache.getBalance(quoteVault) : undefined;

        let priceSolPerToken: string | null = null;
        if (baseVaultBalance !== undefined && quoteVaultBalance !== undefined) {
            const baseNum = Number(baseVaultBalance);
            const quoteNum = Number(quoteVaultBalance);
            if (baseNum > 0 && quoteNum > 0) {
                if (quoteIsSol && !baseIsSol) priceSolPerToken = (quoteNum / baseNum).toString();
                else if (baseIsSol && !quoteIsSol) priceSolPerToken = (baseNum / quoteNum).toString();
            }
        }

        return {
            pubkey: entry.pubkey,
            slot: entry.slot.toString(),
            firstSeenTs: entry.firstSeenTs,
            lastUpdatedTs: entry.lastUpdatedTs,
            createdSlot: entry.createdSlot?.toString() ?? null,
            createdTs: entry.createdTs,
            detectedDuringSync: entry.detectedDuringSync,
            lpMint: s.lpMint.toBase58(),
            baseMint,
            quoteMint,
            baseVault,
            quoteVault,
            baseVaultBalance: baseVaultBalance?.toString() ?? null,
            quoteVaultBalance: quoteVaultBalance?.toString() ?? null,
            priceSolPerToken,
            quoteType: "SOL",
            fee: RAYDIUM_V4_FEE,
            status: s.status ?? null,
            openTime: s.openTime ?? null,
            tokenMint
        };
    });

    const raydiumClmmPools = marketCache.getAllRaydiumCLMMPools().map((entry) => {
        const s = entry.state;
        const mint0 = s.tokenMint0.toBase58();
        const mint1 = s.tokenMint1.toBase58();
        const mint0IsSol = isSolMint(mint0);
        const mint1IsSol = isSolMint(mint1);

        let tokenMint: string | null = null;
        let quoteType: "SOL" | "USDC" | "USDT" | "UNKNOWN" = "UNKNOWN";
        if (mint0IsSol && isMemecoin(mint1)) {
            tokenMint = mint1;
            quoteType = "SOL";
        } else if (mint1IsSol && isMemecoin(mint0)) {
            tokenMint = mint0;
            quoteType = "SOL";
        } else if (isStablecoin(mint0) && isMemecoin(mint1)) {
            tokenMint = mint1;
            quoteType = getQuoteType(mint0);
        } else if (isStablecoin(mint1) && isMemecoin(mint0)) {
            tokenMint = mint0;
            quoteType = getQuoteType(mint1);
        }

        const vault0 = s.tokenVault0.toBase58();
        const vault1 = s.tokenVault1.toBase58();
        const vault0Balance = tokenAccountCache.getBalance(vault0);
        const vault1Balance = tokenAccountCache.getBalance(vault1);

        // ✅ FIX: Use sqrtPriceX64 instead of reserve ratios
        // Formula: price = (sqrtPriceX64 / 2^64)^2
        let priceSolPerToken: string | null = null;
        const sqrtPriceX64 = s.sqrtPriceX64;
        if (sqrtPriceX64 && sqrtPriceX64 > 0n) {
            const Q64 = BigInt(1) << BigInt(64);
            const sqrtPriceFloat = Number(sqrtPriceX64) / Number(Q64);
            const priceRaw = sqrtPriceFloat * sqrtPriceFloat;
            // Adjust for decimals: SOL=9, token=6 typically
            const decimalAdjust = mint0IsSol ? 1e3 : (mint1IsSol ? 1e-3 : 1);
            const adjustedPrice = priceRaw * decimalAdjust;
            if (mint0IsSol && !mint1IsSol) priceSolPerToken = adjustedPrice.toString();
            else if (mint1IsSol && !mint0IsSol) priceSolPerToken = (1 / adjustedPrice).toString();
        }

        return {
            pubkey: entry.pubkey,
            slot: entry.slot.toString(),
            firstSeenTs: entry.firstSeenTs,
            lastUpdatedTs: entry.lastUpdatedTs,
            createdSlot: entry.createdSlot?.toString() ?? null,
            createdTs: entry.createdTs,
            detectedDuringSync: entry.detectedDuringSync,
            tokenMint0: mint0,
            tokenMint1: mint1,
            tokenVault0: vault0,
            tokenVault1: vault1,
            vault0Balance: vault0Balance?.toString() ?? null,
            vault1Balance: vault1Balance?.toString() ?? null,
            ammConfig: s.ammConfig.toBase58(),
            tickSpacing: s.tickSpacing,
            tickCurrent: s.tickCurrent,
            liquidity: s.liquidity.toString(),
            sqrtPriceX64: s.sqrtPriceX64.toString(),
            price: s.price,
            priceSolPerToken,
            status: s.status,
            isActive: s.isActive,
            openTime: s.openTime,
            quoteType,
            tokenMint
        };
    });

    updateSolUsdPrice(marketCache, tokenAccountCache);

    const pumpSwapPools = marketCache.getAllPumpSwapPools().map((entry) => {
        const s = entry.state;
        const baseMint = s.baseMint.toBase58();
        const quoteMint = s.quoteMint.toBase58();
        const baseIsSol = isSolMint(baseMint);
        const quoteIsSol = isSolMint(quoteMint);

        let tokenMint: string | null = null;
        if (baseIsSol && isMemecoin(quoteMint)) tokenMint = quoteMint;
        else if (quoteIsSol && isMemecoin(baseMint)) tokenMint = baseMint;

        const baseVault = s.poolBaseTokenAccount.toBase58();
        const quoteVault = s.poolQuoteTokenAccount.toBase58();

        const baseVaultBalance = tokenAccountCache.getBalance(baseVault);
        const quoteVaultBalance = tokenAccountCache.getBalance(quoteVault);

        let priceSolPerToken: string | null = null;
        if (baseVaultBalance !== undefined && quoteVaultBalance !== undefined) {
            const baseNum = Number(baseVaultBalance);
            const quoteNum = Number(quoteVaultBalance);
            if (baseNum > 0 && quoteNum > 0) {
                if (quoteIsSol && !baseIsSol) priceSolPerToken = (quoteNum / baseNum).toString();
                else if (baseIsSol && !quoteIsSol) priceSolPerToken = (baseNum / quoteNum).toString();
            }
        }

        return {
            pubkey: entry.pubkey,
            slot: entry.slot.toString(),
            firstSeenTs: entry.firstSeenTs,
            lastUpdatedTs: entry.lastUpdatedTs,
            createdSlot: entry.createdSlot?.toString() ?? null,
            createdTs: entry.createdTs,
            detectedDuringSync: entry.detectedDuringSync,
            index: s.index,
            creator: s.creator.toBase58(),
            baseMint,
            quoteMint,
            lpMint: s.lpMint.toBase58(),
            poolBaseTokenAccount: baseVault,
            poolQuoteTokenAccount: quoteVault,
            baseVaultBalance: baseVaultBalance?.toString() ?? null,
            quoteVaultBalance: quoteVaultBalance?.toString() ?? null,
            priceSolPerToken,
            quoteType: "SOL",
            fee: PUMPSWAP_FEE,
            lpSupply: s.lpSupply.toString(),
            tokenMint
        };
    });

    meteoraPoolsWithHighFees = 0;
    meteoraPoolsWithLowFees = 0;

    const meteoraPools = marketCache.getAllMeteoraPools()
        .filter((entry) => {
            const s = entry.state;
            const tokenXMint = s.tokenXMint.toBase58();
            const tokenYMint = s.tokenYMint.toBase58();
            const xIsQuote = isValidMeteoraQuote(tokenXMint);
            const yIsQuote = isValidMeteoraQuote(tokenYMint);
            const xIsMemecoin = isMemecoin(tokenXMint);
            const yIsMemecoin = isMemecoin(tokenYMint);
            return (xIsQuote && yIsMemecoin) || (yIsQuote && xIsMemecoin);
        })
        .map((entry) => {
            const s = entry.state;
            const tokenXMint = s.tokenXMint.toBase58();
            const tokenYMint = s.tokenYMint.toBase58();

            const xIsSol = isSolMint(tokenXMint);
            const xIsStable = isStablecoin(tokenXMint);
            const xIsQuote = xIsSol || xIsStable;

            let tokenMint: string;
            let quoteMint: string;
            let quoteType: "SOL" | "USDC" | "USDT";

            if (xIsQuote) {
                quoteMint = tokenXMint;
                tokenMint = tokenYMint;
                quoteType = getQuoteType(tokenXMint) as "SOL" | "USDC" | "USDT";
            } else {
                quoteMint = tokenYMint;
                tokenMint = tokenXMint;
                quoteType = getQuoteType(tokenYMint) as "SOL" | "USDC" | "USDT";
            }

            const priceRawTemp = computeMeteoraPrice(s.activeId, s.binStep);
            const priceRaw = xIsQuote ? priceRawTemp : (priceRawTemp > 0 ? 1 / priceRawTemp : 0);
            let priceInSol: number | null = null;
            if (quoteType === "SOL") {
                priceInSol = priceRaw;
            } else if (solUsdPrice > 0) {
                priceInSol = priceRaw / solUsdPrice;
            }

            const exactFee = computeMeteoraFeeFromState(s);
            const isTradeable = isTradeableMeteoraPool(s, MAX_METEORA_FEE_FOR_ARB);

            if (isTradeable) meteoraPoolsWithLowFees++;
            else meteoraPoolsWithHighFees++;

            const reserveXAddr = s.reserveX.toBase58();
            const reserveYAddr = s.reserveY.toBase58();
            const reserveXBalance = tokenAccountCache.getBalance(reserveXAddr);
            const reserveYBalance = tokenAccountCache.getBalance(reserveYAddr);

            return {
                pubkey: entry.pubkey,
                slot: entry.slot.toString(),
                firstSeenTs: entry.firstSeenTs,
                lastUpdatedTs: entry.lastUpdatedTs,
                createdSlot: entry.createdSlot?.toString() ?? null,
                createdTs: entry.createdTs,
                detectedDuringSync: entry.detectedDuringSync,
                tokenXMint,
                tokenYMint,
                reserveX: reserveXAddr,
                reserveY: reserveYAddr,
                reserveXBalance: reserveXBalance?.toString() ?? null,
                reserveYBalance: reserveYBalance?.toString() ?? null,
                activeId: s.activeId,
                binStep: s.binStep,
                status: s.status,
                pairType: s.pairType,
                priceQuotePerToken: priceRaw.toString(),
                priceSolPerToken: priceInSol?.toString() ?? null,
                quoteType,
                quoteMint,
                baseFactor: s.baseFactor,
                variableFeeControl: s.variableFeeControl,
                volatilityAccumulator: s.volatilityAccumulator,
                protocolShare: s.protocolShare,
                baseFeeRate: s.baseFeeRate,
                variableFeeRate: s.variableFeeRate,
                totalFeeRate: s.totalFeeRate,
                exactFee,
                isTradeable,
                tokenMint
            };
        });

    return {
        generatedAt: new Date().toISOString(),
        runId: RUN_ID,
        runDir: RUN_DIR,
        stats: {
            trackedVaults: trackedVaults.size,
            subscribedVaults: subscribedVaults.size,
            cachedVaultBalances: tokenAccountCache.size(),
            initialSyncComplete: isInitialSyncComplete(),
            solUsdPrice,
            lastSolUsdUpdate,
            fees: {
                pumpSwap: PUMPSWAP_FEE,
                raydiumV4: RAYDIUM_V4_FEE,
                raydiumClmm: "Dynamic",
                meteoraNote: "Dynamic"
            },
            raydium: {
                v4Pools: raydiumV4Pools.length,
                clmmPools: raydiumClmmPools.length,
            },
            meteora: {
                totalPools: meteoraPools.length,
                tradeablePools: meteoraPoolsWithLowFees,
                highFeePools: meteoraPoolsWithHighFees,
                tradeablePercent: meteoraPools.length > 0
                    ? ((meteoraPoolsWithLowFees / meteoraPools.length) * 100).toFixed(1) + "%"
                    : "N/A"
            },
            binArrays: {
                subscribed: subscribedBinArrays.size,
                totalSubscriptions: binArraySubscriptionCount
            }
        },
        pumpCurves,
        raydiumV4Pools,
        raydiumClmmPools,
        pumpSwapPools,
        meteoraPools
    };
}

function updateSolUsdPrice(marketCache: MarketCache, tokenAccountCache: any): void {
    for (const entry of marketCache.getAllRaydiumPools()) {
        const s = entry.state;
        const baseMint = s.baseMint.toBase58();
        const quoteMint = s.quoteMint.toBase58();

        const isSOLUSDC =
            (isSolMint(baseMint) && quoteMint === USDC_MINT_STR) ||
            (isSolMint(quoteMint) && baseMint === USDC_MINT_STR);

        if (!isSOLUSDC) continue;

        const baseVault = s.baseVault?.toBase58() ?? null;
        const quoteVault = s.quoteVault?.toBase58() ?? null;
        if (!baseVault || !quoteVault) continue;

        const baseBalance = tokenAccountCache.getBalance(baseVault);
        const quoteBalance = tokenAccountCache.getBalance(quoteVault);
        if (baseBalance === undefined || quoteBalance === undefined) continue;

        const baseNum = Number(baseBalance);
        const quoteNum = Number(quoteBalance);
        if (baseNum <= 0 || quoteNum <= 0) continue;

        if (isSolMint(baseMint)) {
            solUsdPrice = (quoteNum / 1e6) / (baseNum / 1e9);
        } else {
            solUsdPrice = (baseNum / 1e6) / (quoteNum / 1e9);
        }
        lastSolUsdUpdate = Date.now();
        return;
    }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("   YOGURTSLINGER v2.4 - REAL-TIME GRADUATION & FRAGMENTATION   ");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`Mode: ${DRY_RUN ? "DRY RUN" : PAPER_TRADE ? "PAPER TRADE" : "🔴 LIVE"}`);
    console.log(`Geyser: ${GEYSER_ENDPOINT}`);
    console.log(`RPC: ${RPC_ENDPOINT}`);
    console.log(`Wallet: ${WALLET_PATH}`);
    console.log(`Jito: ${JITO_ENDPOINT}`);
    console.log(`Min Spread: ${MIN_CANDIDATE_SPREAD_BPS} bps`);
    console.log(`Max Trade: ${MAX_TRADE_SOL} SOL`);
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`📁 Run ID: ${RUN_ID}`);
    console.log(`📁 Run Dir: ${RUN_DIR}`);
    console.log("───────────────────────────────────────────────────────────────");
    console.log("✅ HYBRID vault subscription (owner + dynamic account-based)");
    console.log("✅ isSolMint() checks both wrapped AND native SOL");
    console.log("✅ isMemecoin() filter excludes stablecoins");
    console.log("✅ FragmentationTracker: Real-time graduation & fragmentation events");
    console.log("✅ NEW_FRAGMENTATION events trigger immediate arb detection");
    console.log("═══════════════════════════════════════════════════════════════\n");

    await fs.mkdir(RUN_DIR, { recursive: true });
    console.log(`[ingest] ✅ Created run directory: ${RUN_DIR}`);

    const capitalConfig: CapitalConfig = {
        totalCapitalLamports: BigInt(Math.floor(TOTAL_CAPITAL_SOL * 1e9)),
        maxPerTradeLamports: BigInt(Math.floor(MAX_TRADE_SOL * 1e9)),
        maxPerTradePercent: 0.25,
        reservePercent: 0.10,
        minTradeLamports: BigInt(10_000_000),
        maxConcurrentTrades: 4
    };

    const engineConfig: Partial<EngineConfig> = {
        walletPath: WALLET_PATH,
        rpcEndpoint: RPC_ENDPOINT,
        jitoEndpoint: JITO_ENDPOINT,
        dryRun: DRY_RUN,
        paperTrade: PAPER_TRADE,
        verboseLogging: DEBUG_INGEST,
        capitalConfig
    };

    cache = new MarketCache();
    resetInitialSyncState();

    const arbBrain = new ArbBrain(cache, {
        minCandidateSpreadBps: 30,
        logPrefix: "[arb]",
        engineConfig: engineConfig,
        logDir: RUN_DIR
    });

    arbBrainRef = arbBrain;

    await arbBrain.start();

    // =========================================================================
    // FRAGMENTATION EVENT HANDLER
    // =========================================================================
    // Subscribe to NEW_FRAGMENTATION events for immediate arb detection
    // This is the CRITICAL path for capturing newly graduated tokens

    fragmentationTracker.subscribe((event: FragmentationEvent) => {
        const venueList = event.allVenues.join("+");

        if (event.type === "GRADUATION") {
            console.log(
                `[GRAD] 🎓 Token graduated to PumpSwap: ${event.tokenMint.slice(0, 8)}...pump | ` +
                `pool=${event.poolPubkey.slice(0, 8)} | slot=${event.slot}`
            );
        } else if (event.type === "NEW_FRAGMENTATION") {
            console.log(
                `[FRAG] 🔥 NEW FRAGMENTATION: ${event.tokenMint.slice(0, 8)}...pump | ` +
                `venues=${venueList} | triggered by ${event.venue} | ` +
                `pool=${event.poolPubkey.slice(0, 8)} | slot=${event.slot}`
            );

            // IMMEDIATELY trigger arb detection for newly fragmented token
            if (arbBrainRef && isInitialSyncComplete()) {
                arbBrainRef.processTokenUpdate(event.tokenMint).catch((err) => {
                    console.error(`[FRAG] Arb detection failed for ${event.tokenMint.slice(0, 8)}:`, err);
                });
            }
        } else if (event.type === "VENUE_ADDED") {
            console.log(
                `[FRAG] ➕ Venue added: ${event.tokenMint.slice(0, 8)}...pump | ` +
                `+${event.venue} | now on ${venueList} (${event.venueCount} venues)`
            );

            // Also trigger arb detection when venue added
            if (arbBrainRef && isInitialSyncComplete()) {
                arbBrainRef.processTokenUpdate(event.tokenMint).catch(() => { });
            }
        }
    });

    console.log("[ingest] ✅ FragmentationTracker wired for real-time graduation/fragmentation detection");

    const binQueryFn = (_poolPubkey: string, _binId: number) => null;
    meteoraEdge.setBinQueryFn(binQueryFn);
    meteoraEdge.setMarketCache(cache);

    const handleFeeDecayOpportunity = async (opp: FeeDecayOpportunity): Promise<void> => {
        console.log(`[EDGE] 🎯 FEE_DECAY: ${opp.poolPubkey.slice(0, 8)}... fee=${(opp.currentFee * 100).toFixed(2)}%`);
        meteoraEdge.feeDecay.clearOpportunity(opp.poolPubkey);
    };

    const handleBackrunOpportunity = async (opp: BackrunOpportunity): Promise<void> => {
        console.log(`[EDGE] 🎯 BACKRUN: ${opp.poolPubkey.slice(0, 8)}... ${opp.binsMoved} bins ${opp.direction}`);
        meteoraEdge.emptyBin.clearOpportunity(opp.poolPubkey);
    };

    (globalThis as any).__meteoraEdgeHandlers = {
        onFeeDecay: handleFeeDecayOpportunity,
        onBackrun: handleBackrunOpportunity,
    };

    console.log("[ingest] ✅ ArbBrain wired to cache updates");
    console.log("[ingest] ✅ Batch processing enabled (size=50, flush=5ms)");

    yellowstoneModule = loadYellowstone();
    await connectGeyserStream(cache);

    attachSummaryLogger(cache, arbBrain);
    attachSnapshotWriter(cache);
    attachInitialSyncMonitor();
    startStreamHealthMonitor(cache);

    const shutdown = async (signal: string) => {
        console.log(`\n[ingest] Received ${signal}, shutting down...`);
        isShuttingDown = true;
        arbBrain.stop();
        if (geyserStream) {
            try { geyserStream.end(); } catch { }
        }
        console.log(`[ingest] Final stats:`);
        console.log(`  - Tracked vaults: ${trackedVaults.size}`);
        console.log(`  - Subscribed for live: ${subscribedVaults.size}`);
        console.log(`  - Cached balances: ${cache.getTokenAccountCache().size()}`);
        console.log(`  - Subscription events: ${vaultSubscriptionCount}`);
        console.log("[ingest] Shutdown complete");
        process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    console.log("\n[ingest] Running... Press Ctrl+C to stop\n");
}

main().catch((err) => {
    console.error("[ingest] Fatal error:", err);
    process.exit(1);
});