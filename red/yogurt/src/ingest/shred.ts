/**
 * Phase 4: ShredStream gRPC Consumer
 *
 * Optimized for MEV hot path:
 * - Streaming parse: emit each tx immediately as parsed
 * - Per-tx timing: t0 captured at tx parse start, not entry receipt
 * - Zero-copy where possible
 * - Pre-allocated buffers for hot path
 */

import { loadPackageDefinition, credentials } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { IngestConsumer, IngestHandler } from './types.js';
import type { TxUpdate, IngestEvent } from '../types.js';
import type { StreamContinuityEvent, StreamContinuityHandler } from './grpc.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const PROTO_LOADER_OPTS = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
    includeDirs: [] as string[],
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_PATH = join(__dirname, '..', 'capture', 'proto', 'shredstream.proto');
const INCLUDE_PATH = join(__dirname, '..', 'capture', 'proto');

// Silence shredstream logs unless DEBUG=1 (control-plane noise, not capture data)
const DEBUG = process.env.DEBUG === '1';

// ============================================================================
// CONFIG
// ============================================================================

export interface ShredStreamConfig {
    endpoint: string;
    reconnectIntervalMs: number;
    maxReconnectAttempts: number;
}

// ============================================================================
// METRICS
// ============================================================================

interface ShredMetrics {
    entriesReceived: bigint;
    txsExtracted: bigint;
    txsEmitted: bigint;
    handlerErrors: bigint;
    reconnectCount: bigint;
    lastSlotSeen: number;
}

function createMetrics(): ShredMetrics {
    return {
        entriesReceived: 0n,
        txsExtracted: 0n,
        txsEmitted: 0n,
        handlerErrors: 0n,
        reconnectCount: 0n,
        lastSlotSeen: 0,
    };
}

// ============================================================================
// COMPACT-U16 PARSING (INLINED FOR SPEED)
// ============================================================================

function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
    const b0 = buf[offset]!;
    if (b0 < 0x80) return [b0, 1];
    const b1 = buf[offset + 1]!;
    if (b0 < 0xc0) return [((b0 & 0x7f) | (b1 << 7)), 2];
    const b2 = buf[offset + 2]!;
    return [((b0 & 0x3f) | (b1 << 6) | (b2 << 14)), 3];
}

// ============================================================================
// STREAMING ENTRY PARSER
// ============================================================================

/**
 * Stream-parse entries and invoke callback for each transaction.
 * Minimizes latency by processing each tx immediately as parsed.
 */
function streamParseEntries(
    data: Buffer,
    slot: number,
    onTx: (signature: Uint8Array, message: Uint8Array, t0: bigint) => void
): number {
    let txCount = 0;
    if (data.length < 56) return 0;

    try {
        let offset = 0;

        // Vec<Entry> length
        const entryCount = Number(data.readBigUInt64LE(offset));
        offset += 8;

        if (entryCount === 0 || entryCount > 1000) return 0;

        for (let i = 0; i < entryCount && offset < data.length; i++) {
            // Entry header: num_hashes (8) + hash (32) = 40 bytes
            if (offset + 48 > data.length) break;
            offset += 40;

            // Transaction count in this entry
            const txInEntry = Number(data.readBigUInt64LE(offset));
            offset += 8;

            if (txInEntry === 0) continue;
            if (txInEntry > 100) break;

            // Process each transaction IMMEDIATELY
            for (let j = 0; j < txInEntry && offset < data.length; j++) {
                // Capture t0 at START of this specific tx parse
                const t0 = process.hrtime.bigint();

                const txSize = getTxSizeFast(data, offset);
                if (txSize <= 0) break;

                // Parse tx inline
                const txEnd = offset + txSize;
                const result = parseTxFast(data, offset, txEnd);

                if (result) {
                    onTx(result.signature, result.message, t0);
                    txCount++;
                }

                offset = txEnd;
            }
        }
    } catch {
        // Silent fail on corrupted data
    }

    return txCount;
}

/**
 * Fast tx size calculation - optimized for speed
 */
function getTxSizeFast(data: Buffer, offset: number): number {
    if (offset + 66 > data.length) return -1;

    let pos = offset;

    // Signature count
    const [sigCount, sigLen] = readCompactU16(data, pos);
    pos += sigLen;
    if (sigCount === 0 || sigCount > 127) return -1;

    // Skip signatures
    pos += sigCount * 64;
    if (pos >= data.length) return -1;

    // Check version
    const firstByte = data[pos]!;
    const isVersioned = (firstByte & 0x80) !== 0;
    if (isVersioned) pos++;

    // Header: 3 bytes
    if (pos + 3 > data.length) return -1;
    pos += 3;

    // Account keys
    const [numKeys, keysLen] = readCompactU16(data, pos);
    pos += keysLen + numKeys * 32;
    if (pos > data.length) return -1;

    // Recent blockhash
    pos += 32;
    if (pos > data.length) return -1;

    // Instructions
    const [numIx, ixLen] = readCompactU16(data, pos);
    pos += ixLen;

    for (let i = 0; i < numIx; i++) {
        if (pos >= data.length) return -1;
        pos++; // program_id_index

        const [numAccounts, accLen] = readCompactU16(data, pos);
        pos += accLen + numAccounts;
        if (pos > data.length) return -1;

        const [dataLen, dataLenBytes] = readCompactU16(data, pos);
        pos += dataLenBytes + dataLen;
        if (pos > data.length) return -1;
    }

    // Address table lookups (v0 only)
    if (isVersioned) {
        const [numLookups, lookupsLen] = readCompactU16(data, pos);
        pos += lookupsLen;

        for (let i = 0; i < numLookups; i++) {
            pos += 32; // account key
            if (pos > data.length) return -1;

            const [numWritable, wLen] = readCompactU16(data, pos);
            pos += wLen + numWritable;
            if (pos > data.length) return -1;

            const [numReadonly, rLen] = readCompactU16(data, pos);
            pos += rLen + numReadonly;
            if (pos > data.length) return -1;
        }
    }

    return pos - offset;
}

/**
 * Fast tx parse - extracts signature and message with minimal copying
 */
function parseTxFast(
    data: Buffer,
    start: number,
    end: number
): { signature: Uint8Array; message: Uint8Array } | null {
    let offset = start;

    // Signature count
    const [sigCount, sigLen] = readCompactU16(data, offset);
    offset += sigLen;

    if (sigCount === 0 || sigCount > 127) return null;
    if (offset + sigCount * 64 >= end) return null;

    // First signature (zero-copy slice)
    const signature = data.subarray(offset, offset + 64);

    // Skip all signatures to get message
    offset += sigCount * 64;

    // Message is rest of tx (zero-copy slice)
    const message = data.subarray(offset, end);

    if (message.length < 3) return null;

    return { signature, message };
}

// ============================================================================
// SHREDSTREAM CONSUMER
// ============================================================================

export class ShredStreamConsumer implements IngestConsumer {
    private readonly config: ShredStreamConfig;
    private handler: IngestHandler | null = null;
    private running = false;

    private client: any = null;
    private stream: any = null;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;

    private metrics: ShredMetrics = createMetrics();

    // Stream continuity handler (for evidence capture)
    private continuityHandler: StreamContinuityHandler | null = null;

    constructor(config: ShredStreamConfig) {
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
                this.continuityHandler({ ...event, streamType: 'shredstream' });
            } catch (err) {
                // Don't let handler errors break consumer
            }
        }
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.metrics = createMetrics();
        await this.connect();
    }

    async stop(): Promise<void> {
        this.running = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.stream) {
            this.stream.cancel();
            this.stream = null;
        }

        this.client = null;
    }

    onEvent(handler: IngestHandler): void {
        this.handler = handler;
    }

    isRunning(): boolean {
        return this.running;
    }

    getMetrics(): {
        entriesReceived: bigint;
        txsExtracted: bigint;
        txsEmitted: bigint;
        handlerErrors: bigint;
        reconnectCount: bigint;
        lastSlotSeen: number;
    } {
        return { ...this.metrics };
    }

    // ========================================================================
    // CONNECTION
    // ========================================================================

    private async connect(): Promise<void> {
        if (!this.running) return;

        try {
            const shredstreamSvc = this.loadProto();

            this.client = new shredstreamSvc.ShredstreamProxy(
                this.config.endpoint,
                credentials.createInsecure()
            );

            this.stream = this.client.SubscribeEntries({});
            const wasReconnect = this.reconnectAttempts > 0;
            this.reconnectAttempts = 0;

            // Emit continuity event: connect or reconnect_success
            this.emitContinuity({
                eventType: wasReconnect ? 'reconnect_success' : 'connect',
                timestamp: Date.now(),
                lastSlotSeen: this.metrics.lastSlotSeen,
            });

            DEBUG && console.log(`[shredstream] Connected to ${this.config.endpoint}`);
            DEBUG && console.log('[shredstream] Subscribed to entries stream');

            this.stream.on('data', (entry: { slot: string; entries: Buffer }) => {
                this.handleEntry(entry);
            });

            this.stream.on('error', (err: any) => {
                // Emit continuity event: disconnect
                this.emitContinuity({
                    eventType: 'disconnect',
                    timestamp: Date.now(),
                    lastSlotSeen: this.metrics.lastSlotSeen,
                    errorMessage: err?.message ?? String(err),
                });
                console.error(`[shredstream] Stream error: ${err?.code ?? ''} ${err?.message ?? err}`);
                this.scheduleReconnect();
            });

            this.stream.on('end', () => {
                // Emit continuity event: disconnect (graceful)
                this.emitContinuity({
                    eventType: 'disconnect',
                    timestamp: Date.now(),
                    lastSlotSeen: this.metrics.lastSlotSeen,
                });
                DEBUG && console.log('[shredstream] Stream ended');
                this.scheduleReconnect();
            });

        } catch (err: any) {
            console.error(`[shredstream] Connection failed: ${err?.message ?? err}`);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (!this.running) return;

        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            console.error(`[shredstream] Max reconnect attempts reached`);
            this.running = false;
            return;
        }

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

        DEBUG && console.log(`[shredstream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    // ========================================================================
    // ENTRY HANDLING - STREAMING
    // ========================================================================

    private handleEntry(entry: { slot: string; entries: Buffer }): void {
        this.metrics.entriesReceived++;

        const slot = Number(entry.slot ?? 0);
        this.metrics.lastSlotSeen = Math.max(this.metrics.lastSlotSeen, slot);

        const handler = this.handler;
        if (!handler) return;

        // Stream parse: each tx emitted immediately with its own t0
        const txCount = streamParseEntries(
            entry.entries,
            slot,
            (signature, message, t0) => {
                this.metrics.txsExtracted++;

                const update: TxUpdate = {
                    slot,
                    signature,
                    isVote: false,
                    message,
                };

                const event: IngestEvent = {
                    type: 'tx',
                    update,
                    source: 'pending',
                };

                try {
                    (event as any).t0 = t0;  // Per-tx timing
                    handler(event);
                    this.metrics.txsEmitted++;
                } catch {
                    this.metrics.handlerErrors++;
                }
            }
        );
    }

    // ========================================================================
    // UTILITIES
    // ========================================================================

    private loadProto(): any {
        const opts = { ...PROTO_LOADER_OPTS, includeDirs: [INCLUDE_PATH] };
        const pkgDef = loadSync(PROTO_PATH, opts as any);
        const loaded = loadPackageDefinition(pkgDef) as any;

        const shredstreamSvc = loaded.shredstream;
        if (!shredstreamSvc?.ShredstreamProxy) {
            throw new Error(`ShredstreamProxy not found in proto at ${PROTO_PATH}`);
        }

        return shredstreamSvc;
    }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createShredStreamConsumer(
    endpoint: string = '127.0.0.1:11000'
): ShredStreamConsumer {
    const config: ShredStreamConfig = {
        endpoint,
        reconnectIntervalMs: 1000,
        maxReconnectAttempts: 100,
    };
    return new ShredStreamConsumer(config);
}