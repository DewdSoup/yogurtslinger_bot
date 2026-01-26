/**
 * Ingest module types
 * Defines the contract between data sources and downstream consumers
 */

import type { IngestEvent, TxUpdate } from '../types.js';

/** Handler for ingest events */
export type IngestHandler = (event: IngestEvent) => void;

/** Ingest consumer interface */
export interface IngestConsumer {
    /** Start consuming */
    start(): Promise<void>;

    /** Stop consuming gracefully */
    stop(): Promise<void>;

    /** Register event handler */
    onEvent(handler: IngestHandler): void;

    /** Current status */
    isRunning(): boolean;
}

/** gRPC connection config (Yellowstone - port 10000) */
export interface GrpcConfig {
    endpoint: string;
    token?: string;
    programIds: string[];           // Programs to subscribe (account owner filter)
    reconnectIntervalMs: number;
    maxReconnectAttempts: number;
}

/** ShredStream gRPC config (Jito - port 11000) */
export interface ShredStreamConfig {
    endpoint: string;               // 127.0.0.1:11000
    programIds: string[];           // Filter transactions by program involvement
    reconnectIntervalMs: number;
    maxReconnectAttempts: number;
}

/** Pending transaction event with timing metadata */
export interface PendingTxEvent {
    type: 'tx';
    source: 'pending';
    update: TxUpdate;
    t0: bigint;                     // process.hrtime.bigint() at recv
}