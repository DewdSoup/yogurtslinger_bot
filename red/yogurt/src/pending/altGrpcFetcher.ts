/**
 * ALT gRPC Fetcher — Fetches Address Lookup Tables via Yellowstone gRPC
 *
 * Replaces RPC-based ALT fetching for production use.
 * Uses the same gRPC infrastructure as confirmed state (Phase 1-3).
 *
 * Design:
 * - Subscribes to ALT accounts via Yellowstone gRPC
 * - Decodes ALT account data on arrival
 * - Persists to hotlist for future cold starts
 * - NO RPC dependency in production hot path
 *
 * ALT Account Layout (AddressLookupTable):
 * - Bytes 0-56: Metadata (type, deactivation_slot, authority, etc.)
 * - Bytes 56+: Array of 32-byte pubkeys (the actual lookup addresses)
 */

import { loadPackageDefinition, credentials, type ClientDuplexStream } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AddressLookupTable } from '../types.js';
import type { AltCache } from '../cache/alt.js';
import { appendToHotlist } from './altFetcher.js';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_PATH = join(__dirname, '..', 'capture', 'proto', 'geyser.proto');

const COMMITMENT_CONFIRMED = 1;

// ALT account metadata size (bytes before address array)
const ALT_METADATA_SIZE = 56;

// Batch settings for subscription updates
const BATCH_INTERVAL_MS = 50;
const BATCH_SIZE_THRESHOLD = 20;

// ============================================================================
// ALT ACCOUNT DECODER
// ============================================================================

/**
 * Decode ALT account data from raw bytes.
 * Returns array of 32-byte pubkeys, or null if invalid.
 */
function decodeAltAccountData(data: Uint8Array): Uint8Array[] | null {
    // Minimum size: metadata + at least one address
    if (data.length < ALT_METADATA_SIZE) {
        return null;
    }

    // Check discriminator (first 4 bytes should be 1 for initialized ALT)
    const discriminator = data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24);
    if (discriminator !== 1) {
        // Not an initialized ALT (could be 0 = uninitialized, 2 = deactivated)
        return null;
    }

    // Address array starts at byte 56
    const addressData = data.slice(ALT_METADATA_SIZE);
    const numAddresses = Math.floor(addressData.length / 32);

    if (numAddresses === 0) {
        return [];
    }

    const addresses: Uint8Array[] = [];
    for (let i = 0; i < numAddresses; i++) {
        const start = i * 32;
        addresses.push(addressData.slice(start, start + 32));
    }

    return addresses;
}

// ============================================================================
// BASE58 ENCODING (for subscription)
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
// ALT GRPC FETCHER
// ============================================================================

export interface AltGrpcFetcherConfig {
    endpoint: string;           // Yellowstone gRPC endpoint (e.g., '127.0.0.1:10000')
    altCache: AltCache;         // Cache to populate with fetched ALTs
    hotlistPath?: string;       // Path to hotlist for persistence (optional)
    onAltFetched?: (pubkey: Uint8Array, addressCount: number) => void;
    onError?: (pubkey: Uint8Array, error: string) => void;
}

export interface AltGrpcFetcher {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    requestAlt: (pubkey: Uint8Array) => void;
    getStats: () => {
        connected: boolean;
        altsRequested: number;
        altsFetched: number;
        altsFailed: number;
        pendingRequests: number;
    };
}

export function createAltGrpcFetcher(config: AltGrpcFetcherConfig): AltGrpcFetcher {
    const { endpoint, altCache, hotlistPath, onAltFetched, onError } = config;

    // State
    let running = false;
    let client: any = null;
    let subscription: ClientDuplexStream<any, any> | null = null;

    // Tracking
    const subscribedAlts: Set<string> = new Set();  // hex keys already subscribed
    const pendingAlts: Set<string> = new Set();     // hex keys waiting to subscribe
    let batchTimer: NodeJS.Timeout | null = null;

    // Metrics
    let altsRequested = 0;
    let altsFetched = 0;
    let altsFailed = 0;

    // ========================================================================
    // PROTO LOADING
    // ========================================================================

    function loadProto(): any {
        const pkgDef = loadSync(PROTO_PATH, PROTO_LOADER_OPTS as any);
        const loaded = loadPackageDefinition(pkgDef) as any;
        const geyserSvc = loaded.geyser ?? loaded.solana?.geyser ?? loaded.agave?.geyser;

        if (!geyserSvc?.Geyser) {
            throw new Error(`Geyser service not found in proto at ${PROTO_PATH}`);
        }

        return geyserSvc;
    }

    // ========================================================================
    // CONNECTION
    // ========================================================================

    async function start(): Promise<void> {
        if (running) return;
        running = true;

        try {
            const geyserSvc = loadProto();
            client = new geyserSvc.Geyser(endpoint, credentials.createInsecure());
            subscription = client.Subscribe();

            // Send empty initial subscription (we'll add ALTs dynamically)
            sendSubscription();

            subscription!.on('data', handleResponse);
            subscription!.on('error', (err: any) => {
                console.error(`[altGrpc] Stream error: ${err?.message ?? err}`);
            });
            subscription!.on('end', () => {
                console.log('[altGrpc] Stream ended');
            });

            console.log(`[altGrpc] Connected to ${endpoint}`);

        } catch (err: any) {
            console.error(`[altGrpc] Connection failed: ${err?.message ?? err}`);
            running = false;
            throw err;
        }
    }

    async function stop(): Promise<void> {
        running = false;

        if (batchTimer) {
            clearTimeout(batchTimer);
            batchTimer = null;
        }

        if (subscription) {
            subscription.cancel();
            subscription = null;
        }

        client = null;
    }

    // ========================================================================
    // ALT REQUESTS
    // ========================================================================

    function requestAlt(pubkey: Uint8Array): void {
        if (!running) return;

        const hex = toHex(pubkey);

        // Skip if already subscribed or pending
        if (subscribedAlts.has(hex) || pendingAlts.has(hex)) {
            return;
        }

        pendingAlts.add(hex);
        altsRequested++;

        scheduleBatchSubscription();
    }

    function scheduleBatchSubscription(): void {
        if (pendingAlts.size >= BATCH_SIZE_THRESHOLD) {
            flushSubscription();
            return;
        }

        if (!batchTimer) {
            batchTimer = setTimeout(() => {
                batchTimer = null;
                flushSubscription();
            }, BATCH_INTERVAL_MS);
        }
    }

    function flushSubscription(): void {
        if (pendingAlts.size === 0 || !subscription) return;

        for (const hex of pendingAlts) {
            subscribedAlts.add(hex);
        }
        pendingAlts.clear();

        sendSubscription();
    }

    function sendSubscription(): void {
        if (!subscription) return;

        if (subscribedAlts.size === 0) {
            // Empty subscription - just maintain connection
            subscription.write({
                accounts: {},
                commitment: COMMITMENT_CONFIRMED,
            });
            return;
        }

        // Subscribe to ALT accounts by pubkey
        const altPubkeysB58: string[] = [];
        for (const hex of subscribedAlts) {
            const bytes = hexToBytes(hex);
            altPubkeysB58.push(toBase58(bytes));
        }

        const subscribeRequest = {
            accounts: {
                'alt_accounts': {
                    account: altPubkeysB58,
                },
            },
            commitment: COMMITMENT_CONFIRMED,
        };

        subscription.write(subscribeRequest);
        console.log(`[altGrpc] Subscribed to ${subscribedAlts.size} ALT accounts`);
    }

    // ========================================================================
    // RESPONSE HANDLING
    // ========================================================================

    function handleResponse(resp: any): void {
        if (!resp.account) return;

        const info = resp.account.account;
        if (!info?.pubkey || !info?.data) return;

        const pubkey = toUint8Array(info.pubkey);
        const data = toUint8Array(info.data);
        const slot = Number(resp.account.slot ?? 0);

        // Decode ALT account data
        const addresses = decodeAltAccountData(data);

        if (addresses === null) {
            altsFailed++;
            if (onError) {
                onError(pubkey, 'Failed to decode ALT account data');
            }
            return;
        }

        // Build ALT structure
        const alt: AddressLookupTable = {
            pubkey,
            addresses,
            slot,
        };

        // Cache it
        altCache.set(pubkey, alt);
        altsFetched++;

        // Persist to hotlist if configured
        if (hotlistPath) {
            appendToHotlist(hotlistPath, toBase58(pubkey));
        }

        if (onAltFetched) {
            onAltFetched(pubkey, addresses.length);
        }
    }

    function toUint8Array(v: any): Uint8Array {
        if (v instanceof Uint8Array) return v;
        if (Buffer.isBuffer(v)) return new Uint8Array(v);
        if (Array.isArray(v)) return new Uint8Array(v);
        if (v?.type === 'Buffer' && Array.isArray(v.data)) {
            return new Uint8Array(v.data);
        }
        return new Uint8Array(0);
    }

    // ========================================================================
    // STATS
    // ========================================================================

    function getStats() {
        return {
            connected: running && subscription !== null,
            altsRequested,
            altsFetched,
            altsFailed,
            pendingRequests: pendingAlts.size,
        };
    }

    return {
        start,
        stop,
        requestAlt,
        getStats,
    };
}

// ============================================================================
// WIRE TO ALT CACHE
// ============================================================================

/**
 * Wire gRPC-based ALT fetcher to cache.
 * Replaces wireAltFetcher() for production use (no RPC dependency).
 */
export function wireAltGrpcFetcher(
    altCache: AltCache,
    grpcEndpoint: string = '127.0.0.1:10000',
    hotlistPath?: string
): AltGrpcFetcher {
    const fetcher = createAltGrpcFetcher({
        endpoint: grpcEndpoint,
        altCache,
        hotlistPath,
        onAltFetched: (pubkey, count) => {
            console.log(`[altGrpc] Fetched ALT ${toBase58(pubkey).slice(0, 8)}... (${count} addresses)`);
        },
    });

    // Set the cache's async fetcher to use gRPC
    altCache.setFetcher(async (pubkey: Uint8Array) => {
        // Request the ALT via gRPC subscription
        fetcher.requestAlt(pubkey);

        // Return null immediately - the cache will be populated when gRPC delivers
        // This maintains the non-blocking behavior of the hot path
        return null;
    });

    return fetcher;
}
