#!/usr/bin/env tsx

import bs58 from 'bs58';
import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createGrpcConsumer } from '../src/ingest/grpc.js';
import { createShredStreamConsumer } from '../src/ingest/shred.js';
import { createPhase2Handler } from '../src/handler/phase2.js';
import { decodePumpSwapPool, decodePumpSwapInstruction, isPumpSwapSwap } from '../src/decode/programs/pumpswap.js';
import { decodeRaydiumV4Pool, decodeRaydiumV4Instruction, isRaydiumV4Swap } from '../src/decode/programs/raydiumV4.js';
import { PROGRAM_IDS, VenueId, type IngestEvent, type PoolState, type CompiledInstruction } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_DIR = join(__dirname, '..', 'data', 'evidence');

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT ?? '127.0.0.1:10000';
const SHRED_ENDPOINT = process.env.SHRED_ENDPOINT ?? '127.0.0.1:11000';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? 'http://127.0.0.1:8899';
const FLUSH_INTERVAL_MS = Number(process.env.WATCH_FLUSH_INTERVAL_MS ?? '2000');
const WINDOW_SECONDS = Number(process.env.WATCH_WINDOW_SECONDS ?? '60');
const ENABLE_RPC_SEED = process.env.SKIP_RPC_SEED !== '1';

const DEBUG = process.env.DEBUG === '1';

const PUMPSWAP_BYTES = new Uint8Array([
    0x0c, 0x14, 0xde, 0xfc, 0x82, 0x5e, 0xc6, 0x76,
    0x94, 0x25, 0x08, 0x18, 0xbb, 0x65, 0x40, 0x65,
    0xf4, 0x29, 0x8d, 0x31, 0x56, 0xd5, 0x71, 0xb4,
    0xd4, 0xf8, 0x09, 0x0c, 0x18, 0xe9, 0xa8, 0x63,
]);

const RAYDIUMV4_BYTES = new Uint8Array([
    0x4b, 0xd9, 0x49, 0xc4, 0x36, 0x02, 0xc3, 0x3f,
    0x20, 0x77, 0x90, 0xed, 0x16, 0xa3, 0x52, 0x4c,
    0xa1, 0xb9, 0x97, 0x5c, 0xf1, 0x21, 0xa2, 0xa9,
    0x0c, 0xff, 0xec, 0x7d, 0xf8, 0xb6, 0x8a, 0xcd,
]);

type VenueName = 'pumpswap' | 'raydiumV4';

interface PoolMeta {
    poolHex: string;
    venue: VenueName;
    pairKey: string;
    lastSlot: number;
    lastSeenMs: number;
}

interface PairStats {
    pairKey: string;
    tokenAHex: string;
    tokenBHex: string;
    tokenAB58: string;
    tokenBB58: string;
    pools: {
        pumpswap: Set<string>;
        raydiumV4: Set<string>;
    };
    pendingLegs: number;
    eligibleLegs: number;
    venueLegs: {
        pumpswap: number;
        raydiumV4: number;
    };
    firstSeenMs: number;
    lastSeenMs: number;
}

interface EligibleEvent {
    ts: number;
    tsIso: string;
    slot: number;
    signatureHex: string;
    venue: VenueName;
    poolHex: string;
    pairKey: string;
    pairBase58: [string, string];
    oppositePoolCount: number;
}

interface RollingLegEvent {
    ts: number;
    eligible: boolean;
}

interface TelemetryCounters {
    pendingTxsReceived: number;
    pendingTxsParsed: number;
    parseFailures: number;
    swapLegsDetected: number;
    unknownPoolLegs: number;
    crossVenueEligibleLegs: number;
    byVenue: {
        pumpswap: {
            legs: number;
            eligible: number;
        };
        raydiumV4: {
            legs: number;
            eligible: number;
        };
    };
}

interface ParsedMessage {
    accountKeys: Uint8Array[];
    instructions: CompiledInstruction[];
}

const pairMap = new Map<string, PairStats>();
const poolMap = new Map<string, PoolMeta>();
const rollingEvents: RollingLegEvent[] = [];
const recentEligibleEvents: EligibleEvent[] = [];

const counters: TelemetryCounters = {
    pendingTxsReceived: 0,
    pendingTxsParsed: 0,
    parseFailures: 0,
    swapLegsDetected: 0,
    unknownPoolLegs: 0,
    crossVenueEligibleLegs: 0,
    byVenue: {
        pumpswap: { legs: 0, eligible: 0 },
        raydiumV4: { legs: 0, eligible: 0 },
    },
};

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outputFile = join(OUTPUT_DIR, `watch-cross-venue-${runId}.json`);
const latestFile = join(OUTPUT_DIR, 'watch-cross-venue-latest.json');
const startedAtMs = Date.now();

const phase2 = createPhase2Handler();
const grpc = createGrpcConsumer(
    [PROGRAM_IDS[VenueId.PumpSwap], PROGRAM_IDS[VenueId.RaydiumV4]],
    GRPC_ENDPOINT,
);
const shred = createShredStreamConsumer(SHRED_ENDPOINT);

let flushTimer: NodeJS.Timeout | null = null;
let logTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function toHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return hex;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function readCompactU16(buf: Uint8Array, offset: number): [number, number] {
    const b0 = buf[offset]!;
    if (b0 < 0x80) return [b0, 1];
    const b1 = buf[offset + 1]!;
    if (b0 < 0xc0) return [((b0 & 0x7f) | (b1 << 7)), 2];
    const b2 = buf[offset + 2]!;
    return [((b0 & 0x3f) | (b1 << 6) | (b2 << 14)), 3];
}

function parseMessageMinimal(msg: Uint8Array): ParsedMessage | null {
    if (msg.length < 4) return null;

    let offset = 0;

    const firstByte = msg[0]!;
    const isVersioned = (firstByte & 0x80) !== 0;
    if (isVersioned) offset = 1;

    if (offset + 3 > msg.length) return null;
    offset += 3;

    const [numAccounts, numAccountsLen] = readCompactU16(msg, offset);
    offset += numAccountsLen;

    if (offset + numAccounts * 32 > msg.length) return null;

    const accountKeys: Uint8Array[] = [];
    for (let i = 0; i < numAccounts; i++) {
        accountKeys.push(msg.subarray(offset, offset + 32));
        offset += 32;
    }

    if (offset + 32 > msg.length) return null;
    offset += 32;

    const [numIxs, numIxsLen] = readCompactU16(msg, offset);
    offset += numIxsLen;

    const instructions: CompiledInstruction[] = [];

    for (let i = 0; i < numIxs; i++) {
        if (offset >= msg.length) break;

        const programIdIndex = msg[offset++]!;

        const [numAccts, numAcctsLen] = readCompactU16(msg, offset);
        offset += numAcctsLen;

        if (offset + numAccts > msg.length) break;

        const accountKeyIndexes: number[] = [];
        for (let j = 0; j < numAccts; j++) {
            accountKeyIndexes.push(msg[offset++]!);
        }

        const [dataLen, dataLenLen] = readCompactU16(msg, offset);
        offset += dataLenLen;

        if (offset + dataLen > msg.length) break;
        const data = msg.subarray(offset, offset + dataLen);
        offset += dataLen;

        instructions.push({ programIdIndex, accountKeyIndexes, data });
    }

    return { accountKeys, instructions };
}

function normalizePair(aHex: string, bHex: string): string {
    return aHex < bHex ? `${aHex}|${bHex}` : `${bHex}|${aHex}`;
}

function splitPair(pairKey: string): [string, string] {
    const [a, b] = pairKey.split('|');
    return [a!, b!];
}

function venueIdToName(venueId: number): VenueName | null {
    if (venueId === VenueId.PumpSwap) return 'pumpswap';
    if (venueId === VenueId.RaydiumV4) return 'raydiumV4';
    return null;
}

function extractPairFromPool(pool: PoolState): { pairKey: string; tokenAHex: string; tokenBHex: string; venue: VenueName } | null {
    const venueName = venueIdToName(pool.venue);
    if (!venueName) return null;

    if (pool.venue === VenueId.PumpSwap || pool.venue === VenueId.RaydiumV4) {
        const tokenAHex = toHex(pool.baseMint);
        const tokenBHex = toHex(pool.quoteMint);
        const pairKey = normalizePair(tokenAHex, tokenBHex);
        return { pairKey, tokenAHex: splitPair(pairKey)[0], tokenBHex: splitPair(pairKey)[1], venue: venueName };
    }

    return null;
}

function upsertPool(poolPubkey: Uint8Array, pool: PoolState, slot: number): void {
    const poolHex = toHex(poolPubkey);
    const pairInfo = extractPairFromPool(pool);
    if (!pairInfo) return;

    const now = Date.now();

    const existing = poolMap.get(poolHex);
    if (existing && (existing.pairKey !== pairInfo.pairKey || existing.venue !== pairInfo.venue)) {
        const oldPair = pairMap.get(existing.pairKey);
        if (oldPair) {
            oldPair.pools[existing.venue].delete(poolHex);
            oldPair.lastSeenMs = now;
        }
    }

    poolMap.set(poolHex, {
        poolHex,
        venue: pairInfo.venue,
        pairKey: pairInfo.pairKey,
        lastSlot: slot,
        lastSeenMs: now,
    });

    let pair = pairMap.get(pairInfo.pairKey);
    if (!pair) {
        pair = {
            pairKey: pairInfo.pairKey,
            tokenAHex: pairInfo.tokenAHex,
            tokenBHex: pairInfo.tokenBHex,
            tokenAB58: bs58.encode(Buffer.from(pairInfo.tokenAHex, 'hex')),
            tokenBB58: bs58.encode(Buffer.from(pairInfo.tokenBHex, 'hex')),
            pools: {
                pumpswap: new Set<string>(),
                raydiumV4: new Set<string>(),
            },
            pendingLegs: 0,
            eligibleLegs: 0,
            venueLegs: {
                pumpswap: 0,
                raydiumV4: 0,
            },
            firstSeenMs: now,
            lastSeenMs: now,
        };
        pairMap.set(pairInfo.pairKey, pair);
    }

    pair.pools[pairInfo.venue].add(poolHex);
    pair.lastSeenMs = now;
}

function recordRollingEvent(eligible: boolean): void {
    const now = Date.now();
    rollingEvents.push({ ts: now, eligible });

    const oldest = now - (WINDOW_SECONDS * 1000);
    while (rollingEvents.length > 0 && rollingEvents[0]!.ts < oldest) {
        rollingEvents.shift();
    }
}

function recordEligibleEvent(event: EligibleEvent): void {
    recentEligibleEvents.push(event);
    if (recentEligibleEvents.length > 5000) {
        recentEligibleEvents.shift();
    }
}

function processPendingTx(event: IngestEvent): void {
    if (event.type !== 'tx' || event.source !== 'pending') return;

    counters.pendingTxsReceived++;

    const parsed = parseMessageMinimal(event.update.message);
    if (!parsed) {
        counters.parseFailures++;
        return;
    }

    counters.pendingTxsParsed++;

    for (const ix of parsed.instructions) {
        const programId = parsed.accountKeys[ix.programIdIndex];
        if (!programId) continue;

        let poolPubkey: Uint8Array | null = null;
        let venue: VenueName | null = null;

        if (bytesEqual(programId, PUMPSWAP_BYTES)) {
            if (!isPumpSwapSwap(ix.data)) continue;
            const leg = decodePumpSwapInstruction(ix, parsed.accountKeys);
            if (!leg) continue;
            poolPubkey = leg.pool;
            venue = 'pumpswap';
        } else if (bytesEqual(programId, RAYDIUMV4_BYTES)) {
            if (!isRaydiumV4Swap(ix.data)) continue;
            const leg = decodeRaydiumV4Instruction(ix, parsed.accountKeys);
            if (!leg) continue;
            poolPubkey = leg.pool;
            venue = 'raydiumV4';
        } else {
            continue;
        }

        counters.swapLegsDetected++;
        counters.byVenue[venue].legs++;

        const poolHex = toHex(poolPubkey);
        const poolMeta = poolMap.get(poolHex);

        if (!poolMeta) {
            counters.unknownPoolLegs++;
            recordRollingEvent(false);
            continue;
        }

        const pair = pairMap.get(poolMeta.pairKey);
        if (!pair) {
            counters.unknownPoolLegs++;
            recordRollingEvent(false);
            continue;
        }

        pair.pendingLegs++;
        pair.venueLegs[venue]++;

        const oppositeCount = venue === 'pumpswap'
            ? pair.pools.raydiumV4.size
            : pair.pools.pumpswap.size;

        if (oppositeCount > 0) {
            counters.crossVenueEligibleLegs++;
            counters.byVenue[venue].eligible++;
            pair.eligibleLegs++;
            recordRollingEvent(true);

            const [aHex, bHex] = splitPair(pair.pairKey);
            recordEligibleEvent({
                ts: Date.now(),
                tsIso: new Date().toISOString(),
                slot: event.update.slot,
                signatureHex: toHex(event.update.signature),
                venue,
                poolHex,
                pairKey: pair.pairKey,
                pairBase58: [bs58.encode(Buffer.from(aHex, 'hex')), bs58.encode(Buffer.from(bHex, 'hex'))],
                oppositePoolCount: oppositeCount,
            });
        } else {
            recordRollingEvent(false);
        }

        pair.lastSeenMs = Date.now();
    }
}

async function rpcRequest(method: string, params: unknown[]): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch(RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params,
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const json = await response.json() as any;
        if (json.error) {
            throw new Error(json.error.message ?? JSON.stringify(json.error));
        }

        return json.result;
    } finally {
        clearTimeout(timeout);
    }
}

async function seedPoolsFromRpc(): Promise<void> {
    const targets = [
        {
            venue: 'pumpswap' as const,
            programId: PROGRAM_IDS[VenueId.PumpSwap],
            dataSize: 211,
        },
        {
            venue: 'raydiumV4' as const,
            programId: PROGRAM_IDS[VenueId.RaydiumV4],
            dataSize: 752,
        },
    ];

    for (const target of targets) {
        const result = await rpcRequest('getProgramAccounts', [
            target.programId,
            {
                encoding: 'base64',
                commitment: 'confirmed',
                filters: [{ dataSize: target.dataSize }],
            },
        ]);

        const rows = Array.isArray(result) ? result : [];

        for (const row of rows) {
            const pubkeyB58 = row?.pubkey;
            const account = row?.account;
            const dataField = account?.data;
            if (!pubkeyB58 || !Array.isArray(dataField) || typeof dataField[0] !== 'string') continue;

            const pubkey = new Uint8Array(bs58.decode(pubkeyB58));
            const data = new Uint8Array(Buffer.from(dataField[0], 'base64'));

            if (target.venue === 'pumpswap') {
                const decoded = decodePumpSwapPool(pubkey, data);
                if (decoded) {
                    upsertPool(pubkey, decoded, 0);
                }
            } else {
                const decoded = decodeRaydiumV4Pool(pubkey, data);
                if (decoded) {
                    upsertPool(pubkey, decoded, 0);
                }
            }
        }

        console.log(`[watch-cross-venue] RPC seed ${target.venue}: ${rows.length} accounts fetched`);
    }
}

function buildSnapshot() {
    const now = Date.now();

    const oldest = now - (WINDOW_SECONDS * 1000);
    while (rollingEvents.length > 0 && rollingEvents[0]!.ts < oldest) {
        rollingEvents.shift();
    }

    let rollingEligible = 0;
    for (const evt of rollingEvents) {
        if (evt.eligible) rollingEligible++;
    }

    const rollingTotal = rollingEvents.length;

    const pairRows = Array.from(pairMap.values()).map((pair) => ({
        pairKey: pair.pairKey,
        pairBase58: [pair.tokenAB58, pair.tokenBB58],
        pairHex: [pair.tokenAHex, pair.tokenBHex],
        pools: {
            pumpswap: Array.from(pair.pools.pumpswap),
            raydiumV4: Array.from(pair.pools.raydiumV4),
            pumpswapCount: pair.pools.pumpswap.size,
            raydiumV4Count: pair.pools.raydiumV4.size,
        },
        isCrossVenue: pair.pools.pumpswap.size > 0 && pair.pools.raydiumV4.size > 0,
        pendingLegs: pair.pendingLegs,
        eligibleLegs: pair.eligibleLegs,
        venueLegs: pair.venueLegs,
        firstSeenAt: new Date(pair.firstSeenMs).toISOString(),
        lastSeenAt: new Date(pair.lastSeenMs).toISOString(),
    }));

    pairRows.sort((a, b) => b.eligibleLegs - a.eligibleLegs);

    const crossVenuePairs = pairRows.filter(p => p.isCrossVenue);

    const uptimeSeconds = Math.floor((now - startedAtMs) / 1000);

    return {
        run: {
            runId,
            startedAt: new Date(startedAtMs).toISOString(),
            lastUpdatedAt: new Date(now).toISOString(),
            uptimeSeconds,
            endpoints: {
                grpc: GRPC_ENDPOINT,
                shred: SHRED_ENDPOINT,
                rpc: RPC_ENDPOINT,
            },
            config: {
                flushIntervalMs: FLUSH_INTERVAL_MS,
                rollingWindowSeconds: WINDOW_SECONDS,
                rpcSeedEnabled: ENABLE_RPC_SEED,
            },
            outputFile,
        },
        counters,
        inventory: {
            poolsTracked: poolMap.size,
            pairCount: pairRows.length,
            crossVenuePairCount: crossVenuePairs.length,
            crossVenuePairs,
            allPairs: pairRows,
        },
        rolling: {
            windowSeconds: WINDOW_SECONDS,
            totalLegs: rollingTotal,
            eligibleLegs: rollingEligible,
            eligibleRatePct: rollingTotal > 0 ? Number(((rollingEligible * 10000) / rollingTotal).toFixed(2)) / 100 : 0,
            legsPerMinute: Number(((rollingTotal * 60) / WINDOW_SECONDS).toFixed(3)),
            eligibleLegsPerMinute: Number(((rollingEligible * 60) / WINDOW_SECONDS).toFixed(3)),
        },
        streamHealth: {
            grpc: grpc.getMetrics(),
            shred: shred.getMetrics(),
        },
        recentEligibleEvents,
    };
}

function writeSnapshot(): void {
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const snapshot = buildSnapshot();
    const content = JSON.stringify(
        snapshot,
        (_key, value) => typeof value === 'bigint' ? value.toString() : value,
        2
    );

    const tempFile = `${outputFile}.tmp`;
    writeFileSync(tempFile, content);
    renameSync(tempFile, outputFile);

    const latestTemp = `${latestFile}.tmp`;
    writeFileSync(latestTemp, content);
    renameSync(latestTemp, latestFile);
}

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[watch-cross-venue] ${signal} received, shutting down...`);

    if (flushTimer) clearInterval(flushTimer);
    if (logTimer) clearInterval(logTimer);

    try {
        await shred.stop();
    } catch {
        // best effort
    }

    try {
        await grpc.stop();
    } catch {
        // best effort
    }

    writeSnapshot();

    console.log(`[watch-cross-venue] final snapshot written: ${outputFile}`);
    process.exit(0);
}

async function main(): Promise<void> {
    console.log('[watch-cross-venue] starting...');
    console.log(`[watch-cross-venue] output: ${outputFile}`);

    grpc.onEvent((event) => {
        phase2.handle(event);

        if (event.type !== 'account') return;

        const poolEntry = phase2.poolCache.get(event.update.pubkey);
        if (!poolEntry) return;

        upsertPool(event.update.pubkey, poolEntry.state, event.update.slot);
    });

    shred.onEvent(processPendingTx);

    await grpc.start();
    await shred.start();

    console.log(`[watch-cross-venue] grpc connected: ${GRPC_ENDPOINT}`);
    console.log(`[watch-cross-venue] shred connected: ${SHRED_ENDPOINT}`);

    if (ENABLE_RPC_SEED) {
        void seedPoolsFromRpc()
            .then(() => {
                console.log('[watch-cross-venue] RPC seed complete');
            })
            .catch((err) => {
                console.error(`[watch-cross-venue] RPC seed failed: ${String(err)}`);
            });
    }

    writeSnapshot();

    flushTimer = setInterval(() => {
        writeSnapshot();
    }, FLUSH_INTERVAL_MS);

    logTimer = setInterval(() => {
        const snapshot = buildSnapshot();
        const rolling = snapshot.rolling;
        console.log(
            `[watch-cross-venue] pools=${snapshot.inventory.poolsTracked} pairs=${snapshot.inventory.pairCount} ` +
            `crossPairs=${snapshot.inventory.crossVenuePairCount} legs=${snapshot.counters.swapLegsDetected} ` +
            `eligible=${snapshot.counters.crossVenueEligibleLegs} rollingRate=${rolling.eligibleRatePct}% ` +
            `eligiblePerMin=${rolling.eligibleLegsPerMinute}`
        );
    }, 10_000);

    if (flushTimer) flushTimer.unref();
    if (logTimer) logTimer.unref();

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    process.on('uncaughtException', (err) => {
        console.error('[watch-cross-venue] uncaughtException:', err);
        void shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
        console.error('[watch-cross-venue] unhandledRejection:', reason);
        void shutdown('unhandledRejection');
    });

    if (DEBUG) {
        console.log('[watch-cross-venue] debug mode enabled');
    }
}

main().catch((err) => {
    console.error('[watch-cross-venue] fatal:', err);
    process.exit(1);
});
