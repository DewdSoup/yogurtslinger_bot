/**
 * Phase 1: Yellowstone gRPC Consumer
 *
 * WBS Gate Requirements:
 * - p99 per-update processing latency < 100μs (handler execution)
 * - Zero backpressure drops over 1hr sustained load
 * - Zero ordering violations over 1hr
 * - Replay consistency: captured stream yields identical cache
 *
 * Design Decisions:
 * 1. SYNCHRONOUS handler - no internal queue. If handler is slow, backpressure
 *    propagates to gRPC stream. This prevents drops at our layer.
 * 2. Ordering is NOT validated here. writeVersion is per-account, not global.
 *    Cache layer (Phase 2) tracks per-pubkey ordering.
 * 3. Capture mode writes raw proto responses for replay validation.
 * 4. Latency measures handler execution time, not parse time.
 *
 * Phase 3 Addition:
 * 5. Dynamic vault subscription - subscribe to specific vault pubkeys for
 *    100% real-time balance updates. No RPC polling.
 */

import { loadPackageDefinition, credentials, type ClientDuplexStream } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createWriteStream, type WriteStream } from 'fs';
import type { IngestConsumer, IngestHandler, GrpcConfig } from './types.js';
import type { AccountUpdate, IngestEvent } from '../types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const PROTO_LOADER_OPTS = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
};

// Resolve proto path relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_PATH = join(__dirname, '..', 'capture', 'proto', 'geyser.proto');

// Commitment level enum from proto
const COMMITMENT_CONFIRMED = 1;

// Silence gRPC logs unless DEBUG=1 (control-plane noise, not capture data)
const DEBUG = process.env.DEBUG === '1';

// Vault subscription batching
const VAULT_BATCH_INTERVAL_MS = 100;
const VAULT_BATCH_SIZE_THRESHOLD = 50;

// ============================================================================
// BASE58 ENCODING
// ============================================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function toBase58(bytes: Uint8Array): string {
    let num = 0n;
    for (const byte of bytes) {
        num = num * 256n + BigInt(byte);
    }

    let str = '';
    while (num > 0n) {
        const mod = Number(num % 58n);
        str = BASE58_ALPHABET[mod] + str;
        num = num / 58n;
    }

    for (const byte of bytes) {
        if (byte === 0) str = '1' + str;
        else break;
    }

    return str || '1';
}

function toHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return hex;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

// ============================================================================
// METRICS
// ============================================================================

interface GrpcMetrics {
    updatesReceived: bigint;
    handlerExecutions: bigint;
    handlerErrors: bigint;
    reconnectCount: bigint;
    lastSlotSeen: number;
    handlerLatencyNs: bigint[];  // Rolling window for percentile calc
    // Vault subscription metrics
    vaultsSubscribed: number;
    subscriptionUpdates: number;
    // Slot rollback detection (potential reorgs)
    slotRollbackCount: bigint;
}

function createMetrics(): GrpcMetrics {
    return {
        updatesReceived: 0n,
        handlerExecutions: 0n,
        handlerErrors: 0n,
        reconnectCount: 0n,
        lastSlotSeen: 0,
        handlerLatencyNs: [],
        vaultsSubscribed: 0,
        subscriptionUpdates: 0,
        slotRollbackCount: 0n,
    };
}

// ============================================================================
// STREAM CONTINUITY EVENT (for evidence capture)
// ============================================================================

/**
 * Stream continuity event emitted on connect/disconnect/reconnect/rollback
 * Used by capture-evidence.ts to prove session validity
 */
export interface StreamContinuityEvent {
    streamType: 'grpc' | 'shredstream';
    eventType: 'connect' | 'disconnect' | 'reconnect_scheduled' | 'reconnect_success' | 'slot_rollback';
    timestamp: number;
    lastSlotSeen: number;
    errorMessage?: string;
    reconnectAttempt?: number;
    /** For slot_rollback: how many slots back (lastSlotSeen - incomingSlot) */
    rollbackDepth?: number;
    /** For slot_rollback: the slot we rolled back from */
    rollbackFromSlot?: number;
}

export type StreamContinuityHandler = (event: StreamContinuityEvent) => void;

// ============================================================================
// GRPC CONSUMER
// ============================================================================

export class GrpcConsumer implements IngestConsumer {
    private readonly config: GrpcConfig;
    private handler: IngestHandler | null = null;
    private running = false;

    // gRPC state
    private client: any = null;
    private subscription: ClientDuplexStream<any, any> | null = null;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;

    // Metrics
    private metrics: GrpcMetrics = createMetrics();
    private readonly maxLatencySamples = 10000;

    // Capture mode for replay validation
    private captureStream: WriteStream | null = null;
    private captureEnabled = false;

    // Dynamic vault subscription (Phase 3)
    private subscribedVaults: Set<string> = new Set(); // hex keys
    private pendingVaults: Set<string> = new Set(); // hex keys waiting to be subscribed
    private vaultBatchTimer: NodeJS.Timeout | null = null;
    private vaultSubscriptionEnabled = false;

    // Stream continuity handler (for evidence capture)
    private continuityHandler: StreamContinuityHandler | null = null;

    // gRPC subscription start slot - captured from FIRST response, immutable after set
    private grpcSubscriptionStartSlot: number | null = null;

    constructor(config: GrpcConfig) {
        this.config = config;
    }

    /**
     * Register handler for stream continuity events (connect/disconnect/reconnect)
     * Used by capture-evidence.ts to prove session validity
     */
    onContinuityEvent(handler: StreamContinuityHandler): void {
        this.continuityHandler = handler;
    }

    /**
     * Emit continuity event if handler is registered
     */
    private emitContinuity(event: Omit<StreamContinuityEvent, 'streamType'>): void {
        if (this.continuityHandler) {
            try {
                this.continuityHandler({ ...event, streamType: 'grpc' });
            } catch (err) {
                // Don't let handler errors break consumer
            }
        }
    }

    // ========================================================================
    // PUBLIC API
    // ========================================================================

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.metrics = createMetrics();
        await this.connect();
    }

    async stop(): Promise<void> {
        this.running = false;

        if (this.vaultBatchTimer) {
            clearTimeout(this.vaultBatchTimer);
            this.vaultBatchTimer = null;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.subscription) {
            this.subscription.cancel();
            this.subscription = null;
        }

        this.client = null;

        if (this.captureStream) {
            this.captureStream.end();
            this.captureStream = null;
        }
    }

    onEvent(handler: IngestHandler): void {
        this.handler = handler;
    }

    isRunning(): boolean {
        return this.running;
    }

    /**
     * Enable capture mode for replay validation (Gate 4).
     * Writes raw proto responses as newline-delimited JSON.
     */
    enableCapture(filepath: string): void {
        this.captureStream = createWriteStream(filepath, { flags: 'a' });
        this.captureEnabled = true;
    }

    /**
     * Enable dynamic vault subscription (Phase 3)
     * Must be called before subscribeVaults() will work
     */
    enableVaultSubscription(): void {
        this.vaultSubscriptionEnabled = true;
    }

    /**
     * Subscribe to vault accounts for real-time balance updates.
     * Vaults are batched and subscription updated periodically.
     * Returns count of newly added vaults.
     */
    subscribeVaults(vaultPubkeys: Uint8Array[]): number {
        if (!this.vaultSubscriptionEnabled) return 0;

        let added = 0;
        for (const pubkey of vaultPubkeys) {
            const hex = toHex(pubkey);
            if (!this.subscribedVaults.has(hex) && !this.pendingVaults.has(hex)) {
                this.pendingVaults.add(hex);
                added++;
            }
        }

        if (added > 0) {
            this.scheduleBatchSubscription();
        }

        return added;
    }

    /**
     * Get count of subscribed vaults
     */
    getSubscribedVaultCount(): number {
        return this.subscribedVaults.size;
    }

    /**
     * Get the gRPC subscription start slot.
     * This is captured from the FIRST gRPC response and is immutable.
     * Used for convergence validation in Phase 2.
     */
    getGrpcSubscriptionStartSlot(): number | null {
        return this.grpcSubscriptionStartSlot;
    }

    /**
     * Get current metrics snapshot.
     */
    getMetrics(): {
        updatesReceived: bigint;
        handlerExecutions: bigint;
        handlerErrors: bigint;
        reconnectCount: bigint;
        lastSlotSeen: number;
        handlerLatencyP99Us: number;
        vaultsSubscribed: number;
        subscriptionUpdates: number;
        slotRollbackCount: bigint;
        // DIAGNOSTIC: For hang detection
        lastGrpcEntryTs: number;
        lastGrpcEntrySlot: number;
        grpcEntryCount: number;
    } {
        return {
            updatesReceived: this.metrics.updatesReceived,
            handlerExecutions: this.metrics.handlerExecutions,
            handlerErrors: this.metrics.handlerErrors,
            reconnectCount: this.metrics.reconnectCount,
            lastSlotSeen: this.metrics.lastSlotSeen,
            handlerLatencyP99Us: this.calculateP99Us(),
            vaultsSubscribed: this.subscribedVaults.size,
            subscriptionUpdates: this.metrics.subscriptionUpdates,
            slotRollbackCount: this.metrics.slotRollbackCount,
            // DIAGNOSTIC: For hang detection
            lastGrpcEntryTs: this.lastGrpcEntryTs,
            lastGrpcEntrySlot: this.lastGrpcEntrySlot,
            grpcEntryCount: this.grpcEntryCount,
        };
    }

    // ========================================================================
    // VAULT SUBSCRIPTION
    // ========================================================================

    private scheduleBatchSubscription(): void {
        // Check if we should flush immediately (threshold reached)
        if (this.pendingVaults.size >= VAULT_BATCH_SIZE_THRESHOLD) {
            this.flushVaultSubscription();
            return;
        }

        // Otherwise schedule flush if not already scheduled
        if (!this.vaultBatchTimer) {
            this.vaultBatchTimer = setTimeout(() => {
                this.vaultBatchTimer = null;
                this.flushVaultSubscription();
            }, VAULT_BATCH_INTERVAL_MS);
        }
    }

    private flushVaultSubscription(): void {
        if (this.pendingVaults.size === 0 || !this.subscription) return;

        // Move pending to subscribed
        for (const hex of this.pendingVaults) {
            this.subscribedVaults.add(hex);
        }
        this.pendingVaults.clear();

        this.metrics.vaultsSubscribed = this.subscribedVaults.size;

        // Send updated subscription
        this.sendSubscription();
    }

    private sendSubscription(): void {
        if (!this.subscription) return;

        const accounts: Record<string, any> = {};

        // Filter 1: DEX programs by owner (always present)
        accounts['target_programs'] = {
            owner: this.config.programIds,
        };

        // Filter 2: Vaults by account pubkey (if any)
        if (this.subscribedVaults.size > 0) {
            const vaultPubkeysB58: string[] = [];
            for (const hex of this.subscribedVaults) {
                const bytes = hexToBytes(hex);
                vaultPubkeysB58.push(toBase58(bytes));
            }
            accounts['tracked_vaults'] = {
                account: vaultPubkeysB58,
            };
        }

        const subscribeRequest: Record<string, any> = {
            accounts,
            commitment: COMMITMENT_CONFIRMED,
        };
        // Optional: from_slot can be set to request streaming from a specific slot
        // If not set, server starts from current slot (default behavior)

        this.subscription.write(subscribeRequest);
        this.metrics.subscriptionUpdates++;

        if (this.subscribedVaults.size > 0) {
            DEBUG && console.log(`[grpc] Subscription updated: ${this.config.programIds.length} programs + ${this.subscribedVaults.size} vaults`);
        }
    }

    // ========================================================================
    // CONNECTION
    // ========================================================================

    private async connect(): Promise<void> {
        if (!this.running) return;

        try {
            const geyserSvc = this.loadProto();

            this.client = new geyserSvc.Geyser(
                this.config.endpoint,
                credentials.createInsecure()
            );

            this.subscription = this.client.Subscribe();
            const wasReconnect = this.reconnectAttempts > 0;
            this.reconnectAttempts = 0;

            // BUG FIX (Phase 2): Reset start slot on reconnect
            // Without this, stale slot from previous session causes false convergence
            if (wasReconnect) {
                this.grpcSubscriptionStartSlot = null;
                DEBUG && console.log('[grpc] Reset subscription start slot on reconnect');
            }

            // Emit continuity event: connect or reconnect_success
            this.emitContinuity({
                eventType: wasReconnect ? 'reconnect_success' : 'connect',
                timestamp: Date.now(),
                lastSlotSeen: this.metrics.lastSlotSeen,
            });

            // Send initial subscription (programs only, vaults added dynamically)
            this.sendSubscription();

            DEBUG && console.log(`[grpc] Connected to ${this.config.endpoint}`);
            DEBUG && console.log(`[grpc] Subscribed to ${this.config.programIds.length} program owners`);

            // Handle incoming data
            this.subscription!.on('data', (resp: any) => this.handleResponse(resp));

            this.subscription!.on('error', (err: any) => {
                // Emit continuity event: disconnect
                this.emitContinuity({
                    eventType: 'disconnect',
                    timestamp: Date.now(),
                    lastSlotSeen: this.metrics.lastSlotSeen,
                    errorMessage: err?.message ?? String(err),
                });
                console.error(`[grpc] Stream error: ${err?.message ?? err}`);
                this.scheduleReconnect();
            });

            this.subscription!.on('end', () => {
                // Emit continuity event: disconnect (graceful)
                this.emitContinuity({
                    eventType: 'disconnect',
                    timestamp: Date.now(),
                    lastSlotSeen: this.metrics.lastSlotSeen,
                });
                DEBUG && console.log('[grpc] Stream ended');
                this.scheduleReconnect();
            });

        } catch (err: any) {
            console.error(`[grpc] Connection failed: ${err?.message ?? err}`);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (!this.running) return;

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error(`[grpc] Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
            this.running = false;
            return;
        }

        // Exponential backoff: base * 2^attempts, capped at 30s
        const delay = Math.min(
            this.config.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts),
            30000
        );
        this.reconnectAttempts++;
        this.metrics.reconnectCount++;

        // Emit continuity event: reconnect_scheduled
        this.emitContinuity({
            eventType: 'reconnect_scheduled',
            timestamp: Date.now(),
            lastSlotSeen: this.metrics.lastSlotSeen,
            reconnectAttempt: this.reconnectAttempts,
        });

        DEBUG && console.log(`[grpc] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    // ========================================================================
    // RESPONSE HANDLING
    // ========================================================================

    // DIAGNOSTIC: Track gRPC entry for hang detection
    private lastGrpcEntryTs = 0;
    private lastGrpcEntrySlot = 0;
    private grpcEntryCount = 0;

    private handleResponse(resp: any): void {
        // DIAGNOSTIC: Mark entry into handleResponse
        this.lastGrpcEntryTs = Date.now();
        this.grpcEntryCount++;

        // CRITICAL: Capture ingest timestamp FIRST, before any processing
        const ingestTimestampMs = Date.now();

        // Capture raw response if enabled (for replay validation)
        if (this.captureEnabled && this.captureStream) {
            // Write as JSON with timestamp for replay ordering
            const captureRecord = {
                ts: ingestTimestampMs,
                resp: this.serializeForCapture(resp),
            };
            this.captureStream.write(JSON.stringify(captureRecord) + '\n');
        }

        // Only process account updates (ignore slots, pings, etc.)
        if (!resp.account) return;

        this.metrics.updatesReceived++;

        const info = resp.account.account;
        if (!info?.pubkey) return;

        const slot = Number(resp.account.slot ?? 0);

        // DIAGNOSTIC: Track slot for hang detection
        this.lastGrpcEntrySlot = slot;

        // Capture gRPC subscription start slot from FIRST response (immutable after set)
        // This is used for convergence validation in Phase 2
        if (this.grpcSubscriptionStartSlot === null && slot > 0) {
            this.grpcSubscriptionStartSlot = slot;
            DEBUG && console.log(`[grpc] Subscription start slot captured: ${slot}`);
        }

        // Detect potential slot rollback (reorg)
        // This occurs when validator switches to a different fork with lower slot numbers.
        // CRITICAL: Cache may now hold stale data from orphaned fork - downstream must handle.
        if (slot > 0 && slot < this.metrics.lastSlotSeen) {
            const rollbackDepth = this.metrics.lastSlotSeen - slot;
            this.metrics.slotRollbackCount++;

            this.emitContinuity({
                eventType: 'slot_rollback',
                timestamp: Date.now(),
                lastSlotSeen: slot,  // The new (lower) slot
                rollbackDepth,
                rollbackFromSlot: this.metrics.lastSlotSeen,
            });

            DEBUG && console.warn(
                `[grpc] SLOT ROLLBACK: ${this.metrics.lastSlotSeen} → ${slot} (depth: ${rollbackDepth})`
            );
        }

        this.metrics.lastSlotSeen = Math.max(this.metrics.lastSlotSeen, slot);

        // Build typed update
        const update: AccountUpdate = {
            slot,
            writeVersion: BigInt(info.write_version ?? 0),
            pubkey: this.toUint8Array(info.pubkey),
            owner: this.toUint8Array(info.owner),
            data: this.toUint8Array(info.data ?? []),
            lamports: BigInt(info.lamports ?? 0),
        };

        // Attach ingest timestamp for downstream latency tracking
        const event: IngestEvent = { type: 'account', update, ingestTimestampMs };

        // Synchronous handler execution with latency measurement
        if (this.handler) {
            const t0 = process.hrtime.bigint();
            try {
                this.handler(event);
                this.metrics.handlerExecutions++;
            } catch (err: any) {
                this.metrics.handlerErrors++;
                console.error(`[grpc] Handler error: ${err?.message ?? err}`);
            }
            const latency = process.hrtime.bigint() - t0;
            this.recordLatency(latency);
        }
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    private loadProto(): any {
        const pkgDef = loadSync(PROTO_PATH, PROTO_LOADER_OPTS as any);
        const loaded = loadPackageDefinition(pkgDef) as any;

        // Try multiple possible paths (proto package variations)
        const geyserSvc = loaded.geyser ?? loaded.solana?.geyser ?? loaded.agave?.geyser;

        if (!geyserSvc?.Geyser) {
            throw new Error(`Geyser service not found in proto at ${PROTO_PATH}`);
        }

        return geyserSvc;
    }

    private toUint8Array(v: any): Uint8Array {
        if (v instanceof Uint8Array) return v;
        if (Buffer.isBuffer(v)) return new Uint8Array(v);
        if (Array.isArray(v)) return new Uint8Array(v);
        if (v?.type === 'Buffer' && Array.isArray(v.data)) {
            return new Uint8Array(v.data);
        }
        return new Uint8Array(0);
    }

    private serializeForCapture(resp: any): any {
        // Convert Uint8Arrays to base64 for JSON serialization
        if (!resp.account) return resp;

        const info = resp.account.account;
        if (!info) return resp;

        return {
            account: {
                slot: resp.account.slot,
                is_startup: resp.account.is_startup,
                account: {
                    pubkey: Buffer.from(this.toUint8Array(info.pubkey)).toString('base64'),
                    owner: Buffer.from(this.toUint8Array(info.owner)).toString('base64'),
                    data: Buffer.from(this.toUint8Array(info.data ?? [])).toString('base64'),
                    lamports: String(info.lamports ?? 0),
                    write_version: String(info.write_version ?? 0),
                    executable: info.executable,
                    rent_epoch: String(info.rent_epoch ?? 0),
                },
            },
        };
    }

    private recordLatency(ns: bigint): void {
        this.metrics.handlerLatencyNs.push(ns);
        if (this.metrics.handlerLatencyNs.length > this.maxLatencySamples) {
            this.metrics.handlerLatencyNs.shift();
        }
    }

    private calculateP99Us(): number {
        const samples = this.metrics.handlerLatencyNs;
        if (samples.length === 0) return 0;

        // Sort and get p99
        const sorted = [...samples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const p99Index = Math.floor(sorted.length * 0.99);
        const p99Ns = sorted[p99Index] ?? sorted[sorted.length - 1]!;

        // Convert ns to μs
        return Number(p99Ns / 1000n);
    }
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create gRPC consumer with default config for local Yellowstone.
 */
export function createGrpcConsumer(
    programIds: string[],
    endpoint: string = '127.0.0.1:10000'
): GrpcConsumer {
    const config: GrpcConfig = {
        endpoint,
        programIds,
        reconnectIntervalMs: 1000,
        maxReconnectAttempts: 100,
    };
    return new GrpcConsumer(config);
}

// ============================================================================
// REPLAY LOADER (for Gate 4 validation)
// ============================================================================

/**
 * Replay captured stream and emit events to handler.
 * Used for Gate 4: replay yields identical cache state.
 */
export async function replayCapture(
    filepath: string,
    handler: IngestHandler
): Promise<{ count: number; errors: number }> {
    const { createReadStream } = await import('fs');
    const { createInterface } = await import('readline');

    const stream = createReadStream(filepath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let count = 0;
    let errors = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;

        try {
            const record = JSON.parse(line);
            const resp = record.resp;

            if (!resp?.account?.account) continue;

            const info = resp.account.account;
            const update: AccountUpdate = {
                slot: Number(resp.account.slot ?? 0),
                writeVersion: BigInt(info.write_version ?? 0),
                pubkey: new Uint8Array(Buffer.from(info.pubkey, 'base64')),
                owner: new Uint8Array(Buffer.from(info.owner, 'base64')),
                data: new Uint8Array(Buffer.from(info.data ?? '', 'base64')),
                lamports: BigInt(info.lamports ?? 0),
            };

            handler({ type: 'account', update });
            count++;
        } catch {
            errors++;
        }
    }

    return { count, errors };
}