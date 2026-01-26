// src/streams/shredstreamConsumer.ts
//
// ShredStream consumer for pre-confirmation transaction detection.
//
// Connects to jito-shredstream-proxy gRPC service (port 11000) and
// deserializes entries to extract pending transactions.
//
// Integration:
// - Feeds SpeculativeStateManager with pending transactions
// - Emits events for opportunity detection pipeline
// - Maintains connection health with automatic reconnection

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { loadPackageDefinition, credentials, type ServiceError } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import {
    SpeculativeStateManager,
    parseShredstreamTransaction,
    isPendingSwap,
    type PendingTransaction,
} from "../state/speculativeState";
import type { PubkeyStr } from "../state/accountStore";

// ============================================================================
// Types
// ============================================================================

export interface ShredstreamConfig {
    /** gRPC address for shredstream proxy (default: 127.0.0.1:11000) */
    grpcAddress: string;
    /** Programs to filter for (only emit swaps for these) */
    targetPrograms: PubkeyStr[];
    /** Path to shredstream.proto */
    protoPath?: string;
    /** Reconnect delay on disconnect (ms) */
    reconnectDelayMs?: number;
    /** Max reconnect attempts before giving up */
    maxReconnectAttempts?: number;
}

export interface ShredstreamStats {
    connected: boolean;
    entriesReceived: number;
    transactionsParsed: number;
    swapsDetected: number;
    parseErrors: number;
    reconnectCount: number;
    lastEntryAt: number;
    latencyMs: number; // Estimated latency from shred to detection
}

export interface SwapDetectedEvent {
    tx: PendingTransaction;
    programId: PubkeyStr;
    discriminator: Buffer;
    detectedAt: number;
}

// ============================================================================
// Solana Entry Deserialization
// ============================================================================

/**
 * Deserialize Solana entries from ShredStream.
 * Entry format: https://docs.rs/solana-entry/latest/solana_entry/entry/struct.Entry.html
 *
 * Layout (bincode serialized Vec<Entry>):
 * - Vec length (u64 LE)
 * - For each entry:
 *   - num_hashes (u64 LE)
 *   - hash (32 bytes)
 *   - transactions Vec:
 *     - Vec length (u64 LE)
 *     - For each transaction: versioned transaction bytes
 */
function deserializeEntries(data: Buffer): Buffer[] {
    const transactions: Buffer[] = [];

    try {
        let offset = 0;

        // Read Vec<Entry> length
        if (offset + 8 > data.length) return transactions;
        const numEntries = Number(data.readBigUInt64LE(offset));
        offset += 8;

        for (let i = 0; i < numEntries && offset < data.length; i++) {
            // num_hashes (u64)
            if (offset + 8 > data.length) break;
            offset += 8;

            // hash (32 bytes)
            if (offset + 32 > data.length) break;
            offset += 32;

            // transactions Vec length
            if (offset + 8 > data.length) break;
            const numTxs = Number(data.readBigUInt64LE(offset));
            offset += 8;

            for (let j = 0; j < numTxs && offset < data.length; j++) {
                // Transaction is length-prefixed in bincode
                if (offset + 8 > data.length) break;
                const txLen = Number(data.readBigUInt64LE(offset));
                offset += 8;

                if (offset + txLen > data.length) break;
                const txBytes = data.subarray(offset, offset + txLen);
                transactions.push(Buffer.from(txBytes));
                offset += txLen;
            }
        }
    } catch {
        // Malformed data, return what we have
    }

    return transactions;
}

// ============================================================================
// ShredStream Consumer
// ============================================================================

export class ShredstreamConsumer extends EventEmitter {
    private config: Required<ShredstreamConfig>;
    private specManager: SpeculativeStateManager;
    private targetPrograms: Set<PubkeyStr>;

    private client: any = null;
    private stream: any = null;
    private reconnectAttempts: number = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private running: boolean = false;

    private stats: ShredstreamStats = {
        connected: false,
        entriesReceived: 0,
        transactionsParsed: 0,
        swapsDetected: 0,
        parseErrors: 0,
        reconnectCount: 0,
        lastEntryAt: 0,
        latencyMs: 0,
    };

    constructor(config: ShredstreamConfig, specManager: SpeculativeStateManager) {
        super();
        this.config = {
            grpcAddress: config.grpcAddress,
            targetPrograms: config.targetPrograms,
            protoPath: config.protoPath ?? path.join(__dirname, "..", "capture", "proto", "shredstream.proto"),
            reconnectDelayMs: config.reconnectDelayMs ?? 1000,
            maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
        };
        this.specManager = specManager;
        this.targetPrograms = new Set(config.targetPrograms);
    }

    /**
     * Start consuming ShredStream entries.
     */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        await this.connect();
    }

    /**
     * Stop consuming and disconnect.
     */
    stop(): void {
        this.running = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.stream) {
            this.stream.cancel();
            this.stream = null;
        }
        this.stats.connected = false;
        this.emit("disconnected");
    }

    /**
     * Get current stats.
     */
    getStats(): ShredstreamStats {
        return { ...this.stats };
    }

    private async connect(): Promise<void> {
        try {
            // Load proto
            const protoPath = this.config.protoPath;
            if (!fs.existsSync(protoPath)) {
                throw new Error(`shredstream.proto not found at ${protoPath}`);
            }

            const pkgDef = loadSync(protoPath, {
                keepCase: true,
                longs: String,
                enums: String,
                defaults: false,
                oneofs: true,
            });

            const loaded = loadPackageDefinition(pkgDef) as any;
            const shredstreamSvc = loaded.shredstream?.ShredstreamProxy;

            if (!shredstreamSvc) {
                throw new Error("ShredstreamProxy service not found in proto");
            }

            // Create client
            this.client = new shredstreamSvc(
                this.config.grpcAddress,
                credentials.createInsecure()
            );

            // Subscribe to entries
            this.stream = this.client.SubscribeEntries({});

            this.stream.on("data", (entry: any) => this.handleEntry(entry));

            this.stream.on("error", (err: ServiceError) => {
                console.error(`[shredstream] Stream error: ${err.message}`);
                this.stats.connected = false;
                this.emit("error", err);
                this.scheduleReconnect();
            });

            this.stream.on("end", () => {
                console.log("[shredstream] Stream ended");
                this.stats.connected = false;
                this.emit("disconnected");
                this.scheduleReconnect();
            });

            this.stats.connected = true;
            this.reconnectAttempts = 0;
            console.log(`[shredstream] Connected to ${this.config.grpcAddress}`);
            this.emit("connected");

        } catch (err: any) {
            console.error(`[shredstream] Connection failed: ${err.message}`);
            this.emit("error", err);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (!this.running) return;
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error(`[shredstream] Max reconnect attempts reached, giving up`);
            this.emit("maxReconnectsReached");
            return;
        }

        this.reconnectAttempts++;
        this.stats.reconnectCount++;

        const delay = this.config.reconnectDelayMs * Math.min(this.reconnectAttempts, 5);
        console.log(`[shredstream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private handleEntry(entry: any): void {
        const receiveTime = Date.now();
        this.stats.entriesReceived++;
        this.stats.lastEntryAt = receiveTime;

        const slot = Number(entry.slot ?? 0);
        const entriesData = entry.entries;

        if (!entriesData || entriesData.length === 0) return;

        const entriesBuf = Buffer.isBuffer(entriesData)
            ? entriesData
            : Buffer.from(entriesData);

        // Deserialize entries to get transactions
        const rawTxs = deserializeEntries(entriesBuf);

        for (const rawTx of rawTxs) {
            try {
                const pending = parseShredstreamTransaction(rawTx, slot);
                if (!pending) {
                    this.stats.parseErrors++;
                    continue;
                }

                this.stats.transactionsParsed++;

                // Check if it's a swap we care about
                const swapCheck = isPendingSwap(pending, this.targetPrograms);

                if (swapCheck.isSwap && swapCheck.programId) {
                    this.stats.swapsDetected++;

                    // Add to speculative state manager
                    this.specManager.addPendingTransaction(pending);

                    // Emit event for opportunity detection
                    const event: SwapDetectedEvent = {
                        tx: pending,
                        programId: swapCheck.programId,
                        discriminator: swapCheck.discriminator ?? Buffer.alloc(8),
                        detectedAt: receiveTime,
                    };

                    this.emit("swapDetected", event);

                    // Estimate latency (rough - based on slot timing)
                    // A slot is ~400ms, so if we see slot N, we're ~400ms behind
                    // This is a rough estimate
                    this.stats.latencyMs = Date.now() - receiveTime;
                }
            } catch {
                this.stats.parseErrors++;
            }
        }
    }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a ShredStream consumer with default configuration.
 */
export function createShredstreamConsumer(
    specManager: SpeculativeStateManager,
    options: Partial<ShredstreamConfig> = {}
): ShredstreamConsumer {
    const config: ShredstreamConfig = {
        grpcAddress: options.grpcAddress ?? "127.0.0.1:11000",
        targetPrograms: options.targetPrograms ?? [
            "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap
            "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium V4
            "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
            "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
        ] as PubkeyStr[],
        ...(options.protoPath !== undefined && { protoPath: options.protoPath }),
        ...(options.reconnectDelayMs !== undefined && { reconnectDelayMs: options.reconnectDelayMs }),
        ...(options.maxReconnectAttempts !== undefined && { maxReconnectAttempts: options.maxReconnectAttempts }),
    };

    return new ShredstreamConsumer(config, specManager);
}
