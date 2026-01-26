// src/brain/arbBrain.ts
// ═══════════════════════════════════════════════════════════════════════════════
// ARBBRAIN: EVENT-DRIVEN ARBITRAGE BRAIN WITH LOCAL SIMULATION
// ═══════════════════════════════════════════════════════════════════════════════

import { MarketCache } from "./marketCache.js";
import { binArrayCache, BinArrayCache } from "./binArrayCache.js";
import {
    FragmentationArbDetector,
    type ArbSignal
} from "../signals/fragmentationArb.js";
import {
    processOpportunity,
    initializeEngine,
    getEngineStatus,
    type ExecutionResult,
    type EngineConfig
} from "../execution/executionEngine.js";
import {
    type OpportunityInput
} from "../execution/executionGate.js";
import {
    type PoolState,
    FEES,
    quickSpreadCheck,
    getConstrainingLiquidity
} from "../execution/profitSimulator.js";
import {
    validateSignal,
    type SimGateConfig,
    type SimGateResult,
    DEFAULT_SIMGATE_CONFIG
} from "../simulation/arbSimGate.js";
import {
    getAuditLogger,
    type ArbAuditLogger
} from "../utils/arbAuditLogger.js";
import {
    simAccuracyTracker
} from "../simulation/simAccuracyTracker.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Debug flag - set ARB_DEBUG=1 to enable verbose logging
const ARB_DEBUG = process.env.ARB_DEBUG === "1";

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface ArbBrainOptions {
    minCandidateSpreadBps?: number;
    logPrefix?: string;
    engineConfig?: Partial<EngineConfig>;
    useLocalSimulation?: boolean;
    simGateConfig?: Partial<SimGateConfig>;
    maxTradeLamports?: bigint;
    dryRun?: boolean;
    binArrayCache?: BinArrayCache;
    logDir?: string;
    rpcFallbackConfidence?: number;
}

export class ArbBrain {
    private readonly cache: MarketCache;
    private readonly detector: FragmentationArbDetector;
    private readonly logPrefix: string;
    private readonly minCandidateSpreadBps: number;
    private engineInitialized = false;
    private readonly engineConfig: Partial<EngineConfig>;

    private readonly useLocalSimulation: boolean;
    private readonly simGateConfig: SimGateConfig;
    private readonly maxTradeLamports: bigint;
    private readonly dryRun: boolean;
    private readonly rpcFallbackConfidence: number;

    private readonly binArrayCache: BinArrayCache | null;

    private readonly auditLogger: ArbAuditLogger;

    // Stats
    private tickCount = 0;
    private lastSignalTs: number | null = null;
    private candidatesDetected = 0;
    private candidatesRouted = 0;
    private executionsSuccessful = 0;
    private localSimApproved = 0;
    private localSimRejected = 0;
    private rpcSimRan = 0;
    private rpcFallbackCount = 0;

    private tokenLastChecked = new Map<string, number>();

    constructor(cache: MarketCache, options: ArbBrainOptions = {}) {
        this.cache = cache;
        this.logPrefix = options.logPrefix ?? "[arb]";
        this.minCandidateSpreadBps = options.minCandidateSpreadBps ?? 55;
        this.engineConfig = options.engineConfig ?? {};

        this.useLocalSimulation = options.useLocalSimulation ?? true;
        this.simGateConfig = { ...DEFAULT_SIMGATE_CONFIG, ...options.simGateConfig };
        this.maxTradeLamports = options.maxTradeLamports ?? 2_000_000_000n;
        this.dryRun = options.dryRun ?? true;
        this.rpcFallbackConfidence = options.rpcFallbackConfidence ?? 0.85;

        this.binArrayCache = options.binArrayCache ?? binArrayCache;

        this.auditLogger = getAuditLogger(options.logDir);

        this.detector = new FragmentationArbDetector(
            this.cache,
            null,
            this.minCandidateSpreadBps,
            0.1
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════════

    async start(): Promise<void> {
        // Initialize execution engine (also in dry run for RPC validation)
        try {
            await initializeEngine({ ...this.engineConfig, dryRun: this.dryRun });
            this.engineInitialized = true;
            console.log(`${this.logPrefix} ExecutionEngine initialized (dryRun=${this.dryRun})`);
        } catch (error) {
            console.error(`${this.logPrefix} Failed to initialize engine:`, error);
            if (!this.dryRun) throw error;
            console.warn(`${this.logPrefix} Continuing without RPC validation`);
        }

        this.cache.subscribeToUpdates(this.processUpdate.bind(this));

        this.auditLogger.logStartup({
            useLocalSimulation: this.useLocalSimulation,
            dryRun: this.dryRun,
            maxTradeLamports: this.maxTradeLamports.toString(),
            minCandidateSpreadBps: this.minCandidateSpreadBps,
            minConfidence: this.simGateConfig.minConfidence,
            minNetProfitBps: this.simGateConfig.minNetProfitBps,
            binArrayCacheEnabled: this.binArrayCache !== null
        });

        const status = this.engineInitialized ? getEngineStatus() : null;

        console.log(`${this.logPrefix} ═══════════════════════════════════════════════`);
        console.log(`${this.logPrefix} ArbBrain started`);
        console.log(`${this.logPrefix}   Mode:        ${this.dryRun ? "VALIDATION (dry run)" : "LIVE"}`);
        console.log(`${this.logPrefix}   Local sim:   ${this.useLocalSimulation ? "ENABLED" : "DISABLED"}`);
        console.log(`${this.logPrefix}   BinCache:    ${this.binArrayCache ? "ENABLED" : "DISABLED"}`);
        console.log(`${this.logPrefix}   Engine:      ${status?.mode ?? "NOT_INITIALIZED"}`);
        console.log(`${this.logPrefix}   Min spread:  ${this.minCandidateSpreadBps} bps`);
        console.log(`${this.logPrefix}   Max trade:   ${Number(this.maxTradeLamports) / 1e9} SOL`);
        console.log(`${this.logPrefix}   Debug:       ${ARB_DEBUG ? "ENABLED" : "DISABLED"}`);
        console.log(`${this.logPrefix} ═══════════════════════════════════════════════`);
    }

    stop(): void {
        this.auditLogger.shutdown();
        simAccuracyTracker.printReport();
        console.log(`${this.logPrefix} ArbBrain stopped`);
        this.tokenLastChecked.clear();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENT PROCESSING
    // ═══════════════════════════════════════════════════════════════════════════

    async processTokenUpdate(tokenMint: string): Promise<void> {
        const now = Date.now();
        const lastCheck = this.tokenLastChecked.get(tokenMint);
        if (lastCheck && now - lastCheck < 50) return;
        this.tokenLastChecked.set(tokenMint, now);

        try {
            const detectionStart = performance.now();
            const signal = await this.detector.detectArbForToken(tokenMint);
            const detectionTime = performance.now() - detectionStart;

            if (signal && signal.estimatedNetSpreadBps >= this.minCandidateSpreadBps) {
                this.candidatesDetected++;
                this.lastSignalTs = now;

                this.auditLogger.logDetection(
                    signal.tokenMint,
                    signal.buyVenue,
                    signal.sellVenue,
                    signal.grossSpreadBps,
                    signal.estimatedNetSpreadBps,
                    detectionTime
                );

                if (ARB_DEBUG) {
                    console.log(
                        `${this.logPrefix} 🎯 DETECTED: ${signal.tokenMint.slice(0, 8)}... | ` +
                        `${signal.buyVenue}→${signal.sellVenue} | ` +
                        `spread=${signal.estimatedNetSpreadBps}bps | ` +
                        `detect=${detectionTime.toFixed(1)}ms`
                    );
                }

                this.routeSignal(signal).catch(err => {
                    this.auditLogger.logError(signal.tokenMint, "ROUTE", err);
                });
            }
        } catch (err) {
            this.auditLogger.logError(tokenMint, "DETECTION", err as Error);
        }
    }

    public async processUpdate(pubkey: string, slot: number): Promise<void> {
        this.tickCount++;

        try {
            const signals = await this.detector.detectArbs();
            if (!signals || signals.length === 0) return;

            this.lastSignalTs = Date.now();

            for (const signal of signals) {
                await this.handleSignal(signal, slot);
            }
        } catch (err) {
            this.auditLogger.logError(pubkey, "PROCESS_UPDATE", err as Error);
        }
    }

    private async handleSignal(signal: ArbSignal, slot: number): Promise<void> {
        this.candidatesDetected++;

        const buyPool = this.buildPoolState(signal.buyVenue, signal.tokenMint);
        const sellPool = this.buildPoolState(signal.sellVenue, signal.tokenMint);

        if (!buyPool || !sellPool) return;

        const spreadCheck = quickSpreadCheck(buyPool, sellPool);
        if (!spreadCheck.hasSpread) return;

        this.auditLogger.logDetection(
            signal.tokenMint,
            signal.buyVenue,
            signal.sellVenue,
            signal.grossSpreadBps,
            signal.estimatedNetSpreadBps,
            0
        );

        if (ARB_DEBUG) {
            console.log(
                `${this.logPrefix} 📊 CANDIDATE: ${signal.tokenMint.slice(0, 8)}... | ` +
                `${signal.buyVenue}→${signal.sellVenue} | ` +
                `spread=${spreadCheck.estimatedSpreadBps}bps | slot=${slot}`
            );
        }

        await this.routeSignal(signal);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SIMULATION
    // ═══════════════════════════════════════════════════════════════════════════

    private async routeSignal(signal: ArbSignal): Promise<void> {
        this.candidatesRouted++;

        const buyPool = this.buildPoolState(signal.buyVenue, signal.tokenMint);
        const sellPool = this.buildPoolState(signal.sellVenue, signal.tokenMint);

        if (!buyPool || !sellPool) {
            this.auditLogger.logError(signal.tokenMint, "BUILD_POOLS", "Missing pool state");
            return;
        }

        const liquidity = getConstrainingLiquidity(buyPool, sellPool);

        // ═══════════════════════════════════════════════════════════════════════
        // LOCAL SIMULATION
        // ═══════════════════════════════════════════════════════════════════════

        let localResult: SimGateResult | null = null;
        let localSimTimeMs = 0;

        if (this.useLocalSimulation) {
            try {
                const simStart = performance.now();
                localResult = await validateSignal(
                    signal,
                    this.cache,
                    this.binArrayCache ?? undefined,
                    this.maxTradeLamports,
                    this.simGateConfig
                );
                localSimTimeMs = performance.now() - simStart;

                this.auditLogger.logLocalSim(
                    signal.tokenMint,
                    signal.buyVenue,
                    signal.sellVenue,
                    localResult.approved,
                    localResult.reason,
                    localResult.optimalAmountIn,
                    localResult.expectedProfitLamports,
                    localResult.expectedProfitBps,
                    localResult.expectedTokensOut,
                    localResult.expectedSolOut,
                    localResult.minTokensOut,
                    localResult.minSolOut,
                    localResult.suggestedTipLamports,
                    localResult.confidence,
                    localSimTimeMs,
                    liquidity.buyLiquidity,
                    liquidity.sellLiquidity
                );

                if (localResult.approved) {
                    this.localSimApproved++;
                    simAccuracyTracker.recordPrediction(
                        signal.tokenMint,
                        signal.buyVenue,
                        signal.sellVenue,
                        localResult.expectedProfitLamports,
                        localResult.expectedProfitBps,
                        localResult.expectedTokensOut,
                        localResult.expectedSolOut,
                        localResult.optimalAmountIn,
                        localResult.confidence,
                        localSimTimeMs
                    );

                    if (ARB_DEBUG) {
                        console.log(
                            `${this.logPrefix} ✅ LOCAL: ${signal.tokenMint.slice(0, 8)}... | ` +
                            `profit=${Number(localResult.expectedProfitLamports) / 1e9} SOL | ` +
                            `${localResult.expectedProfitBps}bps | ` +
                            `conf=${(localResult.confidence * 100).toFixed(0)}% | ` +
                            `${localSimTimeMs.toFixed(1)}ms`
                        );
                    }
                } else {
                    this.localSimRejected++;
                    if (ARB_DEBUG && !localResult.reason?.includes("not profitable")) {
                        console.log(
                            `${this.logPrefix} ⏭️ LOCAL REJECT: ${signal.tokenMint.slice(0, 8)}... | ` +
                            `reason=${localResult.reason} | ${localSimTimeMs.toFixed(1)}ms`
                        );
                    }
                }
            } catch (err) {
                this.auditLogger.logError(signal.tokenMint, "LOCAL_SIM", err as Error);
                localResult = null;
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // EXECUTION (dry run just logs)
        // ═══════════════════════════════════════════════════════════════════════

        if (this.dryRun) {
            if (localResult?.approved) {
                if (ARB_DEBUG) {
                    console.log(
                        `${this.logPrefix} [DRY RUN] Would execute: ${signal.tokenMint.slice(0, 8)}... | ` +
                        `amount=${Number(localResult.optimalAmountIn) / 1e9} SOL | ` +
                        `expected=${Number(localResult.expectedProfitLamports) / 1e9} SOL profit`
                    );
                }

                // RPC VALIDATION: Compare local sim against RPC ground truth
                if (this.engineInitialized) {
                    try {
                        const rpcStart = performance.now();
                        const rpcResult = await processOpportunity({
                            tokenMint: signal.tokenMint,
                            buyPool,
                            sellPool,
                            detectedAt: Date.now(),
                            createdAt: buyPool.createdTs ?? sellPool.createdTs ?? null
                        });
                        const rpcSimTimeMs = performance.now() - rpcStart;
                        this.rpcSimRan++;

                        const rpcApproved = rpcResult.simGateResult?.success ?? false;
                        const rpcProfitBps = rpcResult.simGateResult?.netProfitBps ?? 0;
                        const rpcProfitLamports = rpcResult.simGateResult?.netProfitLamports ?? BigInt(0);

                        // Log RPC result
                        this.auditLogger.logRpcSim(
                            signal.tokenMint,
                            signal.buyVenue,
                            signal.sellVenue,
                            rpcApproved,
                            rpcResult.error ?? null,
                            rpcProfitLamports,
                            rpcProfitBps,
                            rpcSimTimeMs,
                            rpcResult.simGateResult?.error ?? null
                        );

                        if (ARB_DEBUG) {
                            console.log(
                                `${this.logPrefix} ${rpcApproved ? "✅" : "❌"} RPC: ${signal.tokenMint.slice(0, 8)}... | ` +
                                `profit=${rpcProfitBps}bps | ${rpcSimTimeMs.toFixed(1)}ms`
                            );
                        }

                        // Compare local vs RPC
                        const profitDeltaBps = localResult.expectedProfitBps - rpcProfitBps;
                        const latencyAdvantageMs = rpcSimTimeMs - localSimTimeMs;
                        const agreement = localResult.approved === rpcApproved;

                        this.auditLogger.logComparison(
                            signal.tokenMint,
                            signal.buyVenue,
                            signal.sellVenue,
                            localResult.approved,
                            rpcApproved,
                            localResult.expectedProfitLamports,
                            rpcProfitLamports,
                            localSimTimeMs,
                            rpcSimTimeMs,
                            localResult.confidence
                        );

                        // Record RPC as ground truth for accuracy tracking
                        simAccuracyTracker.recordActual(
                            signal.tokenMint,
                            rpcProfitLamports,
                            BigInt(rpcProfitBps),
                            rpcResult.simGateResult?.tokensReceived ?? BigInt(0),
                            Number(rpcResult.simGateResult?.solReceived ?? BigInt(0)),
                            rpcApproved,
                            String(rpcSimTimeMs)
                        );

                        if (ARB_DEBUG && (!agreement || Math.abs(profitDeltaBps) > 20)) {
                            console.log(
                                `${this.logPrefix} ⚠️ ${agreement ? "DRIFT" : "DIVERGENCE"}: ${signal.tokenMint.slice(0, 8)}... | ` +
                                `local=${localResult.approved ? "✓" : "✗"} rpc=${rpcApproved ? "✓" : "✗"} | ` +
                                `delta=${profitDeltaBps > 0 ? "+" : ""}${profitDeltaBps}bps | ` +
                                `latency=${latencyAdvantageMs.toFixed(0)}ms faster`
                            );
                        }
                    } catch (err) {
                        this.auditLogger.logError(signal.tokenMint, "RPC_VALIDATION", err as Error);
                    }
                }
            }
            return;
        }

        // LIVE EXECUTION
        if (localResult?.approved && localResult.confidence >= this.rpcFallbackConfidence) {
            if (ARB_DEBUG) {
                console.log(
                    `${this.logPrefix} 🚀 EXECUTING (local): ${signal.tokenMint.slice(0, 8)}... | ` +
                    `amount=${Number(localResult.optimalAmountIn) / 1e9} SOL`
                );
            }

            const opportunity: OpportunityInput = {
                tokenMint: signal.tokenMint,
                buyPool,
                sellPool,
                detectedAt: Date.now(),
                createdAt: buyPool.createdTs ?? sellPool.createdTs ?? null
            };

            try {
                const result = await processOpportunity(opportunity);
                this.handleExecutionResult(signal, result, true);
            } catch (err) {
                this.auditLogger.logError(signal.tokenMint, "EXECUTION", err as Error);
            }
        } else if (localResult && localResult.confidence < this.rpcFallbackConfidence) {
            this.rpcFallbackCount++;
            this.auditLogger.logRpcFallback(
                signal.tokenMint,
                `LOW_CONFIDENCE_${(localResult.confidence * 100).toFixed(0)}`,
                localResult.confidence,
                localResult.approved
            );

            // Fall back to RPC-based execution
            const opportunity: OpportunityInput = {
                tokenMint: signal.tokenMint,
                buyPool,
                sellPool,
                detectedAt: Date.now(),
                createdAt: buyPool.createdTs ?? sellPool.createdTs ?? null
            };

            try {
                const result = await processOpportunity(opportunity);
                this.handleExecutionResult(signal, result, false);
            } catch (err) {
                this.auditLogger.logError(signal.tokenMint, "EXECUTION_RPC", err as Error);
            }
        }
    }

    private handleExecutionResult(
        signal: ArbSignal,
        result: ExecutionResult,
        usedLocalSim: boolean
    ): void {
        if (result.success) {
            this.executionsSuccessful++;

            const profitLamports = result.profitLamports ?? 0n;

            this.auditLogger.logExecution(
                signal.tokenMint,
                signal.buyVenue,
                signal.sellVenue,
                true,
                0n,
                profitLamports,
                0n, 0n, 0n,
                result.executionTimeMs,
                result.bundleId ?? null,
                null,
                usedLocalSim
            );

            // Always log successful executions (important!)
            console.log(
                `${this.logPrefix} ✅ EXECUTED: ${signal.tokenMint.slice(0, 8)}... | ` +
                `profit=${Number(profitLamports) / 1e9} SOL | ` +
                `bundle=${result.bundleId ?? "N/A"} | ` +
                `${result.executionTimeMs}ms`
            );
        } else {
            this.auditLogger.logExecution(
                signal.tokenMint,
                signal.buyVenue,
                signal.sellVenue,
                false,
                0n, 0n, 0n, 0n, 0n,
                result.executionTimeMs,
                null,
                result.error ?? "Unknown error",
                usedLocalSim
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // POOL STATE BUILDING
    // ═══════════════════════════════════════════════════════════════════════════

    private buildPoolState(venue: string, tokenMint: string): PoolState | null {
        const tokenAccountCache = this.cache.getTokenAccountCache();
        const venueLower = venue.toLowerCase();

        switch (venueLower) {
            case "pumpswap":
                return this.buildPumpSwapPoolState(tokenMint, tokenAccountCache);
            case "raydium":
            case "raydiumv4":
                return this.buildRaydiumPoolState(tokenMint, tokenAccountCache);
            case "raydiumclmm":
                return this.buildRaydiumCLMMPoolState(tokenMint, tokenAccountCache);
            case "meteora":
                return this.buildMeteoraPoolState(tokenMint, tokenAccountCache);
            default:
                return null;
        }
    }

    private buildPumpSwapPoolState(
        tokenMint: string,
        tokenAccountCache: ReturnType<MarketCache["getTokenAccountCache"]>
    ): PoolState | null {
        for (const entry of this.cache.getAllPumpSwapPools()) {
            const baseMint = entry.state.baseMint.toBase58();
            const quoteMint = entry.state.quoteMint.toBase58();

            const isMatch =
                (baseMint === tokenMint && quoteMint === SOL_MINT) ||
                (quoteMint === tokenMint && baseMint === SOL_MINT);

            if (!isMatch) continue;

            const baseVault = entry.state.poolBaseTokenAccount.toBase58();
            const quoteVault = entry.state.poolQuoteTokenAccount.toBase58();

            const baseBalance = tokenAccountCache.getBalance(baseVault);
            const quoteBalance = tokenAccountCache.getBalance(quoteVault);

            if (baseBalance === undefined || quoteBalance === undefined) continue;

            const tokenIsBase = baseMint === tokenMint;

            return {
                pubkey: entry.pubkey,
                venue: "PumpSwap",
                tokenMint,
                baseReserve: tokenIsBase ? baseBalance : quoteBalance,
                quoteReserve: tokenIsBase ? quoteBalance : baseBalance,
                baseMint: tokenMint,
                quoteMint: SOL_MINT,
                feeRate: FEES.PUMPSWAP,
                lastSlot: entry.slot,
                lastUpdatedTs: entry.lastUpdatedTs,
                createdTs: entry.createdTs
            };
        }
        return null;
    }

    private buildRaydiumPoolState(
        tokenMint: string,
        tokenAccountCache: ReturnType<MarketCache["getTokenAccountCache"]>
    ): PoolState | null {
        for (const entry of this.cache.getAllRaydiumPools()) {
            const baseMint = entry.state.baseMint.toBase58();
            const quoteMint = entry.state.quoteMint.toBase58();

            const isMatch =
                (baseMint === tokenMint && quoteMint === SOL_MINT) ||
                (quoteMint === tokenMint && baseMint === SOL_MINT);

            if (!isMatch) continue;

            const baseVault = entry.state.baseVault?.toBase58();
            const quoteVault = entry.state.quoteVault?.toBase58();

            if (!baseVault || !quoteVault) continue;

            const baseBalance = tokenAccountCache.getBalance(baseVault);
            const quoteBalance = tokenAccountCache.getBalance(quoteVault);

            if (baseBalance === undefined || quoteBalance === undefined) continue;

            const tokenIsBase = baseMint === tokenMint;

            return {
                pubkey: entry.pubkey,
                venue: "Raydium",
                tokenMint,
                baseReserve: tokenIsBase ? baseBalance : quoteBalance,
                quoteReserve: tokenIsBase ? quoteBalance : baseBalance,
                baseMint: tokenMint,
                quoteMint: SOL_MINT,
                feeRate: FEES.RAYDIUM,
                lastSlot: entry.slot,
                lastUpdatedTs: entry.lastUpdatedTs,
                createdTs: entry.createdTs
            };
        }
        return null;
    }

    private buildRaydiumCLMMPoolState(
        tokenMint: string,
        tokenAccountCache: ReturnType<MarketCache["getTokenAccountCache"]>
    ): PoolState | null {
        for (const entry of this.cache.getAllRaydiumCLMMPools()) {
            const mint0 = entry.state.tokenMint0.toBase58();
            const mint1 = entry.state.tokenMint1.toBase58();

            const isMatch =
                (mint0 === tokenMint && mint1 === SOL_MINT) ||
                (mint1 === tokenMint && mint0 === SOL_MINT);

            if (!isMatch) continue;
            if (entry.state.status !== 0) continue;

            const vault0 = entry.state.tokenVault0.toBase58();
            const vault1 = entry.state.tokenVault1.toBase58();

            const balance0 = tokenAccountCache.getBalance(vault0);
            const balance1 = tokenAccountCache.getBalance(vault1);

            if (balance0 === undefined || balance1 === undefined) continue;

            const tokenIs0 = mint0 === tokenMint;

            return {
                pubkey: entry.pubkey,
                venue: "RaydiumCLMM",
                tokenMint,
                baseReserve: tokenIs0 ? balance0 : balance1,
                quoteReserve: tokenIs0 ? balance1 : balance0,
                baseMint: tokenMint,
                quoteMint: SOL_MINT,
                feeRate: FEES.RAYDIUM_CLMM,
                binStep: entry.state.tickSpacing,
                activeId: entry.state.tickCurrent,
                lastSlot: entry.slot,
                lastUpdatedTs: entry.lastUpdatedTs,
                createdTs: entry.createdTs,
                clmmData: {
                    sqrtPriceX64: entry.state.sqrtPriceX64,
                    liquidity: entry.state.liquidity,
                    tickCurrent: entry.state.tickCurrent,
                    tickSpacing: entry.state.tickSpacing,
                    tokenVault0: entry.state.tokenVault0,
                    tokenVault1: entry.state.tokenVault1,
                    tokenMint0: entry.state.tokenMint0,
                    tokenMint1: entry.state.tokenMint1,
                    ammConfig: entry.state.ammConfig,
                    observationKey: entry.state.observationKey,
                }
            };
        }
        return null;
    }

    private buildMeteoraPoolState(
        tokenMint: string,
        tokenAccountCache: ReturnType<MarketCache["getTokenAccountCache"]>
    ): PoolState | null {
        for (const entry of this.cache.getAllMeteoraPools()) {
            const tokenXMint = entry.state.tokenXMint.toBase58();
            const tokenYMint = entry.state.tokenYMint.toBase58();

            const isMatch =
                (tokenXMint === tokenMint && tokenYMint === SOL_MINT) ||
                (tokenYMint === tokenMint && tokenXMint === SOL_MINT);

            if (!isMatch) continue;

            const reserveX = entry.state.reserveX.toBase58();
            const reserveY = entry.state.reserveY.toBase58();

            const xBalance = tokenAccountCache.getBalance(reserveX);
            const yBalance = tokenAccountCache.getBalance(reserveY);

            if (xBalance === undefined || yBalance === undefined) continue;

            const tokenIsX = tokenXMint === tokenMint;

            return {
                pubkey: entry.pubkey,
                venue: "Meteora",
                tokenMint,
                baseReserve: tokenIsX ? xBalance : yBalance,
                quoteReserve: tokenIsX ? yBalance : xBalance,
                baseMint: tokenMint,
                quoteMint: SOL_MINT,
                feeRate: entry.state.totalFeeRate ?? FEES.METEORA_DEFAULT,
                binStep: entry.state.binStep,
                activeId: entry.state.activeId,
                lastSlot: entry.slot,
                lastUpdatedTs: entry.lastUpdatedTs,
                createdTs: entry.createdTs
            };
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATS
    // ═══════════════════════════════════════════════════════════════════════════

    printStats(): void {
        const approvalRate = this.candidatesRouted > 0
            ? ((this.localSimApproved / this.candidatesRouted) * 100).toFixed(1)
            : "0.0";

        console.log(`\n${this.logPrefix} ═══════════════════════════════════════════════`);
        console.log(`${this.logPrefix} ArbBrain Stats`);
        console.log(`${this.logPrefix} ───────────────────────────────────────────────`);
        console.log(`${this.logPrefix}   Ticks processed:     ${this.tickCount}`);
        console.log(`${this.logPrefix}   Candidates detected: ${this.candidatesDetected}`);
        console.log(`${this.logPrefix}   Candidates routed:   ${this.candidatesRouted}`);
        console.log(`${this.logPrefix}   Local sim approved:  ${this.localSimApproved}`);
        console.log(`${this.logPrefix}   Local sim rejected:  ${this.localSimRejected}`);
        console.log(`${this.logPrefix}   Approval rate:       ${approvalRate}%`);
        console.log(`${this.logPrefix}   RPC fallbacks:       ${this.rpcFallbackCount}`);
        console.log(`${this.logPrefix}   Executions success:  ${this.executionsSuccessful}`);
        if (this.lastSignalTs) {
            console.log(`${this.logPrefix}   Last signal:         ${Math.round((Date.now() - this.lastSignalTs) / 1000)}s ago`);
        }
        console.log(`${this.logPrefix} ═══════════════════════════════════════════════\n`);
    }

    getStats() {
        return {
            tickCount: this.tickCount,
            candidatesDetected: this.candidatesDetected,
            candidatesRouted: this.candidatesRouted,
            localSimApproved: this.localSimApproved,
            localSimRejected: this.localSimRejected,
            rpcSimRan: this.rpcSimRan,
            rpcFallbackCount: this.rpcFallbackCount,
            executionsSuccessful: this.executionsSuccessful,
            lastSignalAgeMs: this.lastSignalTs ? Date.now() - this.lastSignalTs : null,
            engineInitialized: this.engineInitialized,
            binArrayCacheEnabled: this.binArrayCache !== null,
            dryRun: this.dryRun
        };
    }
}

export default ArbBrain;