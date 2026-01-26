// src/pipeline/arbPipeline.ts
//
// Main arbitrage pipeline orchestrator.
//
// This is the top-level integration that connects:
// 1. Yellowstone gRPC → Confirmed state (source of truth)
// 2. ShredStream → Pre-confirmation transactions (latency edge)
// 3. Hot path simulators → Accurate price simulation
// 4. Opportunity detector → Arb path finding
// 5. Bundle builder → Jito submission
//
// Architecture guarantees:
// - Confirmed state is NEVER modified by speculative data
// - Simulations use the SAME code paths for both confirmed and speculative
// - Accuracy validated on confirmed data transfers to predictions

import { EventEmitter } from "events";
import { InMemoryAccountStore, type PubkeyStr } from "../state/accountStore";
import { SpeculativeStateManager } from "../state/speculativeState";
import { UnifiedPoolRegistry, type VenueType } from "../state/unifiedPoolRegistry";
import {
    ShredstreamConsumer,
    createShredstreamConsumer,
    type SwapDetectedEvent,
} from "../streams/shredstreamConsumer";
import {
    OpportunityDetector,
    DEFAULT_OPPORTUNITY_CONFIG,
    type OpportunityConfig,
    type ArbitrageOpportunity,
} from "../detection/opportunityDetector";
import {
    CrossVenueArbDetector,
    DEFAULT_ARB_DETECTOR_CONFIG,
    type ArbOpportunity,
} from "../detection/crossVenueArbDetector";
import {
    decodeSwapInstruction,
    getVenueFromProgramId,
} from "../decoders/swapInstructions";
import type { CachedClmmTickList } from "../sim/clmmHotPath";
import type { CachedDlmmBinMap } from "../sim/dlmmHotPath";

// ============================================================================
// Pipeline Configuration
// ============================================================================

export interface ArbPipelineConfig {
    /** Yellowstone gRPC address */
    grpcAddress: string;
    /** ShredStream gRPC address */
    shredstreamAddress: string;
    /** RPC URL for static account fetches */
    rpcUrl: string;
    /** Opportunity detection config */
    opportunityConfig?: Partial<OpportunityConfig>;
    /** Target programs to monitor */
    targetPrograms?: PubkeyStr[];
    /** Enable ShredStream (pre-confirmation detection) */
    enableShredstream?: boolean;
    /** Stats logging interval (ms) */
    statsIntervalMs?: number;
}

export interface PipelineStats {
    // State management
    confirmedAccountsTracked: number;
    confirmedSlot: number;
    pendingTransactions: number;
    speculativeDeltas: number;

    // ShredStream
    shredstreamConnected: boolean;
    entriesReceived: number;
    swapsDetected: number;

    // Opportunity detection
    opportunitiesFound: number;
    opportunitiesSubmitted: number;
    avgSimLatencyUs: number;

    // Health
    uptimeMs: number;
    lastActivityAt: number;
}

// ============================================================================
// Arbitrage Pipeline
// ============================================================================

export class ArbPipeline extends EventEmitter {
    private config: Required<ArbPipelineConfig>;

    // Core state layers
    private confirmedStore: InMemoryAccountStore;
    private specManager: SpeculativeStateManager;
    private poolRegistry: UnifiedPoolRegistry;

    // Stream consumers
    private shredstreamConsumer: ShredstreamConsumer | null = null;

    // Detection
    private opportunityDetector: OpportunityDetector;
    private crossVenueDetector: CrossVenueArbDetector;

    // Default input for arb detection
    private defaultArbInputLamports: bigint = BigInt(100_000_000); // 0.1 SOL

    // Stats
    private startTime: number = 0;
    private statsTimer: NodeJS.Timeout | null = null;

    constructor(config: ArbPipelineConfig) {
        super();

        this.config = {
            grpcAddress: config.grpcAddress,
            shredstreamAddress: config.shredstreamAddress,
            rpcUrl: config.rpcUrl,
            opportunityConfig: config.opportunityConfig ?? {},
            targetPrograms: config.targetPrograms ?? [
                "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
                "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
                "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
                "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
            ] as PubkeyStr[],
            enableShredstream: config.enableShredstream ?? true,
            statsIntervalMs: config.statsIntervalMs ?? 10000,
        };

        // Initialize state layers
        this.confirmedStore = new InMemoryAccountStore();
        this.specManager = new SpeculativeStateManager();
        this.poolRegistry = new UnifiedPoolRegistry();

        // Initialize opportunity detector (same-venue backruns)
        const oppConfig = {
            ...DEFAULT_OPPORTUNITY_CONFIG,
            ...this.config.opportunityConfig,
        };
        this.opportunityDetector = new OpportunityDetector(
            oppConfig,
            this.specManager,
            this.confirmedStore
        );

        // Initialize cross-venue arb detector
        this.crossVenueDetector = new CrossVenueArbDetector(
            DEFAULT_ARB_DETECTOR_CONFIG,
            this.poolRegistry,
            this.confirmedStore
        );
    }

    /**
     * Register a pool for cross-venue arb detection.
     */
    registerPool(
        poolAddress: PubkeyStr,
        venue: VenueType,
        baseMint: PubkeyStr,
        quoteMint: PubkeyStr,
        venueData: unknown
    ): void {
        this.poolRegistry.registerPool({
            poolAddress,
            venue,
            baseMint,
            quoteMint,
            venueData,
        });
    }

    /**
     * Update CLMM tick list cache for accurate simulation.
     */
    updateClmmTickList(poolAddress: PubkeyStr, tickList: CachedClmmTickList): void {
        this.crossVenueDetector.setClmmTickList(poolAddress, tickList);
    }

    /**
     * Update DLMM bin map cache for accurate simulation.
     */
    updateDlmmBinMap(poolAddress: PubkeyStr, binMap: CachedDlmmBinMap): void {
        this.crossVenueDetector.setDlmmBinMap(poolAddress, binMap);
    }

    /**
     * Set CLMM fee rate from AmmConfig.
     */
    setClmmFeeRate(poolAddress: PubkeyStr, feeRate: number): void {
        this.crossVenueDetector.setClmmFeeRate(poolAddress, feeRate);
    }

    /**
     * Start the pipeline.
     */
    async start(): Promise<void> {
        this.startTime = Date.now();

        console.log("=".repeat(60));
        console.log("ARBITRAGE PIPELINE STARTING");
        console.log("=".repeat(60));
        console.log(`Yellowstone gRPC: ${this.config.grpcAddress}`);
        console.log(`ShredStream:      ${this.config.shredstreamAddress}`);
        console.log(`RPC:              ${this.config.rpcUrl}`);
        console.log(`ShredStream:      ${this.config.enableShredstream ? "ENABLED" : "DISABLED"}`);
        console.log(`Target programs:  ${this.config.targetPrograms.length}`);
        console.log("=".repeat(60));

        // Start ShredStream consumer if enabled
        if (this.config.enableShredstream) {
            await this.startShredstream();
        }

        // Wire up opportunity detection
        this.opportunityDetector.on("opportunityDetected", (opp: ArbitrageOpportunity) => {
            this.handleOpportunity(opp);
        });

        // Start stats logging
        this.statsTimer = setInterval(() => {
            this.logStats();
        }, this.config.statsIntervalMs);

        console.log("\nPipeline running. Waiting for data...\n");
        this.emit("started");
    }

    /**
     * Stop the pipeline.
     */
    stop(): void {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }

        if (this.shredstreamConsumer) {
            this.shredstreamConsumer.stop();
        }

        console.log("\nPipeline stopped.");
        this.emit("stopped");
    }

    /**
     * Feed confirmed account update (from Yellowstone gRPC).
     * This is the source of truth for pool state.
     */
    onConfirmedAccountUpdate(
        pubkey: PubkeyStr,
        owner: PubkeyStr,
        data: Buffer,
        slot: number,
        lamports: bigint = BigInt(0)
    ): void {
        // Update confirmed store
        this.confirmedStore.apply({
            pubkey,
            owner,
            lamports,
            rentEpoch: BigInt(0),
            slot,
            writeVersion: BigInt(0),
            executable: false,
            data,
        });

        // Update speculative manager's confirmed slot
        this.specManager.setConfirmedSlot(slot);

        // Check if any pending transactions are now confirmed
        // (This would be done by matching signatures, simplified here)
    }

    /**
     * Feed confirmed transaction (from Yellowstone gRPC blocks).
     * Used to confirm/invalidate pending transactions.
     */
    onConfirmedTransaction(signature: string, _slot: number, success: boolean): void {
        if (success) {
            this.specManager.confirmTransaction(signature);
        } else {
            this.specManager.failTransaction(signature);
        }
    }

    /**
     * Get current pipeline stats.
     */
    getStats(): PipelineStats {
        const specStats = this.specManager.getStats();
        const detectorStats = this.opportunityDetector.getStats();
        const shredStats = this.shredstreamConsumer?.getStats();

        return {
            confirmedAccountsTracked: this.confirmedStore.size(),
            confirmedSlot: 0, // Would come from gRPC
            pendingTransactions: specStats.pendingQueueSize,
            speculativeDeltas: specStats.deltasSize,

            shredstreamConnected: shredStats?.connected ?? false,
            entriesReceived: shredStats?.entriesReceived ?? 0,
            swapsDetected: shredStats?.swapsDetected ?? 0,

            opportunitiesFound: detectorStats.opportunitiesFound,
            opportunitiesSubmitted: detectorStats.opportunitiesSubmitted,
            avgSimLatencyUs: detectorStats.avgSimLatencyUs,

            uptimeMs: Date.now() - this.startTime,
            lastActivityAt: Math.max(
                detectorStats.lastOpportunityAt,
                shredStats?.lastEntryAt ?? 0
            ),
        };
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private async startShredstream(): Promise<void> {
        this.shredstreamConsumer = createShredstreamConsumer(
            this.specManager,
            {
                grpcAddress: this.config.shredstreamAddress,
                targetPrograms: this.config.targetPrograms,
            }
        );

        // Wire up events
        this.shredstreamConsumer.on("connected", () => {
            console.log("[shredstream] Connected");
            this.emit("shredstreamConnected");
        });

        this.shredstreamConsumer.on("disconnected", () => {
            console.log("[shredstream] Disconnected");
            this.emit("shredstreamDisconnected");
        });

        this.shredstreamConsumer.on("swapDetected", (event: SwapDetectedEvent) => {
            // Feed to opportunity detector (same-venue backruns)
            this.opportunityDetector.onPendingSwap(event);

            // Also check for cross-venue arb opportunities
            this.checkCrossVenueArb(event);
        });

        this.shredstreamConsumer.on("error", (err: Error) => {
            console.error(`[shredstream] Error: ${err.message}`);
            this.emit("shredstreamError", err);
        });

        await this.shredstreamConsumer.start();
    }

    private handleOpportunity(opp: ArbitrageOpportunity): void {
        console.log(`\n[OPPORTUNITY] ${opp.type} detected!`);
        console.log(`  ID:     ${opp.id}`);
        console.log(`  Profit: ${opp.expectedProfit} lamports (${(opp.profitPct * 100).toFixed(3)}%)`);
        console.log(`  Conf:   ${(opp.confidence * 100).toFixed(1)}%`);
        console.log(`  Path:   ${opp.path.map(l => l.venue).join(" → ")}`);

        if (opp.triggerTx) {
            console.log(`  Trigger: ${opp.triggerTx.signature.slice(0, 16)}...`);
        }

        this.emit("opportunity", opp);

        // TODO: Submit to bundle builder
        // This is where the actual execution logic would go
    }

    private checkCrossVenueArb(event: SwapDetectedEvent): void {
        try {
            // Decode the swap to get affected pool
            const { tx, programId } = event;

            for (const ix of tx.instructions) {
                if (ix.programId === programId) {
                    // Resolve accounts
                    const accounts = ix.accountIndices.map(idx =>
                        tx.writeAccounts[idx] ?? tx.readAccounts[idx] ?? ""
                    ) as PubkeyStr[];

                    const decoded = decodeSwapInstruction(programId, ix.data, accounts);
                    if (!decoded) continue;

                    // Get pool info
                    const pool = this.poolRegistry.getPool(decoded.poolAddress);
                    if (!pool) continue;

                    // Check for cross-venue arb
                    const arb = this.crossVenueDetector.detectOpportunity(
                        pool.baseMint,
                        pool.quoteMint,
                        this.defaultArbInputLamports
                    );

                    if (arb) {
                        console.log(`\n[CROSS-VENUE ARB] Detected!`);
                        console.log(`  Buy:    ${arb.buyVenue} @ ${arb.buyPool.slice(0, 8)}...`);
                        console.log(`  Sell:   ${arb.sellVenue} @ ${arb.sellPool.slice(0, 8)}...`);
                        console.log(`  Spread: ${arb.spreadBps} bps`);
                        console.log(`  Profit: ${arb.expectedProfit} lamports (${arb.profitBps} bps)`);

                        this.emit("crossVenueArb", arb);
                    }
                }
            }
        } catch (err) {
            // Log but don't crash
            console.error(`[pipeline] Error checking cross-venue arb: ${err}`);
        }
    }

    private logStats(): void {
        const stats = this.getStats();

        console.log(`[stats] uptime=${Math.floor(stats.uptimeMs / 1000)}s ` +
            `confirmed=${stats.confirmedAccountsTracked} ` +
            `pending=${stats.pendingTransactions} ` +
            `deltas=${stats.speculativeDeltas}`);

        if (this.config.enableShredstream) {
            console.log(`  shredstream: connected=${stats.shredstreamConnected} ` +
                `entries=${stats.entriesReceived} ` +
                `swaps=${stats.swapsDetected}`);
        }

        console.log(`  detection: opps=${stats.opportunitiesFound} ` +
            `submitted=${stats.opportunitiesSubmitted} ` +
            `avgSimLatency=${stats.avgSimLatencyUs.toFixed(0)}µs`);
    }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a pipeline with environment-based configuration.
 */
export function createPipelineFromEnv(): ArbPipeline {
    // These would come from environment variables in production
    const config: ArbPipelineConfig = {
        grpcAddress: process.env.GRPC_ADDRESS ?? "127.0.0.1:10000",
        shredstreamAddress: process.env.SHREDSTREAM_ADDRESS ?? "127.0.0.1:11000",
        rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
        enableShredstream: process.env.ENABLE_SHREDSTREAM !== "false",
    };

    return new ArbPipeline(config);
}

// ============================================================================
// Example Usage
// ============================================================================

/*
import { ArbPipeline } from "./pipeline/arbPipeline";

async function main() {
    const pipeline = new ArbPipeline({
        grpcAddress: "127.0.0.1:10000",
        shredstreamAddress: "127.0.0.1:11000",
        rpcUrl: "https://mainnet.helius-rpc.com/?api-key=...",
        enableShredstream: true,
        opportunityConfig: {
            minProfitLamports: BigInt(1_000_000), // 0.001 SOL
            minProfitPct: 0.005, // 0.5%
        },
    });

    pipeline.on("opportunity", (opp) => {
        console.log("Opportunity found!", opp);
        // Submit to Jito bundle builder
    });

    await pipeline.start();

    // Feed confirmed state from Yellowstone gRPC subscription
    // gRPC.on("accountUpdate", (update) => {
    //     pipeline.onConfirmedAccountUpdate(
    //         update.pubkey,
    //         update.owner,
    //         update.data,
    //         update.slot
    //     );
    // });
}

main().catch(console.error);
*/
