/**
 * ALT Fetcher — Fetches Address Lookup Tables via RPC
 *
 * Production boot sequence:
 * 1. Load hotlist from disk (previously discovered ALTs)
 * 2. Scan recent blocks for DEX txs, extract ALT pubkeys
 * 3. Prefetch all ALTs into cache
 * 4. Wire reactive fetcher for runtime misses
 * 5. On miss: async fetch → cache → append to hotlist
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { AddressLookupTable } from '../types.js';
import type { AltCache } from '../cache/alt.js';

// ============================================================================
// TARGET DEX PROGRAMS (for DEX-specific ALT discovery)
// ============================================================================

const TARGET_DEX_PROGRAMS = new Set([
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
]);

// ============================================================================
// HOTLIST PERSISTENCE
// ============================================================================

interface Hotlist {
    version: number;
    updatedAt: string;
    alts: string[];  // Base58 pubkeys
}

function loadHotlist(path: string): string[] {
    try {
        if (!existsSync(path)) return [];
        const data = readFileSync(path, 'utf-8');
        const hotlist: Hotlist = JSON.parse(data);
        return hotlist.alts ?? [];
    } catch {
        return [];
    }
}

function saveHotlist(path: string, alts: string[]): void {
    try {
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const hotlist: Hotlist = {
            version: 1,
            updatedAt: new Date().toISOString(),
            alts: [...new Set(alts)],
        };
        writeFileSync(path, JSON.stringify(hotlist, null, 2));
    } catch (err) {
        console.error(`[altFetcher] Failed to save hotlist: ${err}`);
    }
}

/** Append a single ALT to the hotlist (for runtime discovery) */
export function appendToHotlist(path: string, altPubkey: string): void {
    const existing = loadHotlist(path);
    if (!existing.includes(altPubkey)) {
        existing.push(altPubkey);
        saveHotlist(path, existing);
    }
}

/** Create a hotlist updater callback for runtime ALT discovery */
export function createHotlistUpdater(hotlistPath: string): (altPubkey: Uint8Array) => void {
    const seen = new Set<string>();
    return (altPubkey: Uint8Array) => {
        const b58 = new PublicKey(altPubkey).toBase58();
        if (seen.has(b58)) return;
        seen.add(b58);
        appendToHotlist(hotlistPath, b58);
    };
}

/**
 * Wire ALT fetcher to cache
 */
export function wireAltFetcher(
    altCache: AltCache,
    rpcEndpoint: string = '127.0.0.1:8899'
): { connection: Connection } {
    const connection = new Connection(`http://${rpcEndpoint}`, 'confirmed');

    const fetcher = async (pubkey: Uint8Array): Promise<AddressLookupTable | null> => {
        try {
            const pk = new PublicKey(pubkey);
            const account = await connection.getAddressLookupTable(pk);

            if (!account.value) return null;

            const addresses: Uint8Array[] = account.value.state.addresses.map(
                addr => addr.toBytes()
            );

            return {
                pubkey,
                addresses,
                slot: account.context.slot,
            };
        } catch {
            return null;
        }
    };

    altCache.setFetcher(fetcher);
    return { connection };
}

// ============================================================================
// SHREDSTREAM WARMUP (RELIABLE)
// ============================================================================

export interface WarmupResult {
    durationMs: number;
    txsProcessed: number;
    altsDiscovered: number;
    finalHitRate: number;
}

/**
 * Warm ALT cache from live ShredStream traffic
 * 
 * This is the RELIABLE method - uses actual pending transactions
 * to discover and cache ALTs that are actively being used.
 */
export async function shredstreamWarmup(
    altCache: AltCache,
    shredstreamEndpoint: string = '127.0.0.1:11000',
    durationMs: number = 300_000,
    onProgress?: (stats: { txs: number; alts: number; hitRate: number }) => void
): Promise<WarmupResult> {
    // Dynamic import to avoid circular dependency
    const { createShredStreamConsumer } = await import('../ingest/shred.js');
    const { decodeTx } = await import('../decode/tx.js');

    const startTime = Date.now();
    let txsProcessed = 0;

    const consumer = createShredStreamConsumer(shredstreamEndpoint);

    consumer.onEvent((event) => {
        if (event.type !== 'tx') return;

        // Attempt decode - triggers ALT fetch on miss
        decodeTx(event.update, altCache);
        txsProcessed++;
    });

    await consumer.start();

    // Progress reporting
    let progressInterval: NodeJS.Timeout | null = null;
    if (onProgress) {
        progressInterval = setInterval(() => {
            onProgress({
                txs: txsProcessed,
                alts: altCache.stats().size,
                hitRate: altCache.hitRate(),
            });
        }, 5000);
    }

    // Wait for warmup duration
    await new Promise(resolve => setTimeout(resolve, durationMs));

    if (progressInterval) clearInterval(progressInterval);
    await consumer.stop();

    return {
        durationMs: Date.now() - startTime,
        txsProcessed,
        altsDiscovered: altCache.stats().size,
        finalHitRate: altCache.hitRate(),
    };
}

// ============================================================================
// BOOTSTRAP (HOTLIST + RPC SCAN)
// ============================================================================

export interface BootstrapResult {
    altsFromHotlist: number;
    altsFromRpcScan: number;
    totalAltsCached: number;
    hotlistPath: string;
    durationMs: number;
    blocksScanned: number;
    dexTxsFound: number;
}

export interface BootstrapConfig {
    hotlistPath: string;
    blocksToScan?: number;  // Default: 500
    onProgress?: (stage: string, detail: string) => void;
}

/**
 * Bootstrap ALT cache from hotlist + recent block scan (DEX-specific)
 *
 * Production boot sequence:
 * 1. Load hotlist from disk (previously discovered ALTs)
 * 2. Scan last N blocks for DEX txs, extract ALT pubkeys
 * 3. Prefetch all ALTs into cache
 * 4. Save merged hotlist for next boot
 */
export async function bootstrapAltCache(
    altCache: AltCache,
    connection: Connection,
    config: BootstrapConfig
): Promise<BootstrapResult> {
    const startTime = Date.now();
    const { hotlistPath, onProgress } = config;
    const blocksToScan = config.blocksToScan ?? 500;

    onProgress?.('start', 'Beginning ALT bootstrap...');

    // Step 1: Load hotlist from disk
    onProgress?.('hotlist', 'Loading hotlist from disk...');
    const hotlistAlts = loadHotlist(hotlistPath);
    onProgress?.('hotlist', `Loaded ${hotlistAlts.length} ALTs from hotlist`);

    // Step 2: Scan recent blocks for DEX txs
    onProgress?.('scan', `Scanning last ${blocksToScan} blocks for DEX ALTs...`);
    const scanResult = await scanRecentBlocksForDexAlts(connection, blocksToScan, onProgress);
    const newAlts = [...scanResult.alts].filter(alt => !hotlistAlts.includes(alt));
    onProgress?.('scan', `Found ${scanResult.alts.size} ALTs (${newAlts.length} new)`);

    // Step 3: Prefetch all ALTs
    const allAlts = [...new Set([...hotlistAlts, ...scanResult.alts])];
    onProgress?.('prefetch', `Prefetching ${allAlts.length} ALTs...`);

    const batchSize = 100;
    let prefetched = 0;

    for (let i = 0; i < allAlts.length; i += batchSize) {
        const batch = allAlts.slice(i, i + batchSize);
        const pubkeyBytes = batch.map(pk => new PublicKey(pk).toBytes());
        await altCache.prefetch(pubkeyBytes);
        prefetched += batch.length;

        if (prefetched % 500 === 0) {
            onProgress?.('prefetch', `Prefetched ${prefetched}/${allAlts.length} ALTs`);
        }
    }

    // Step 4: Save merged hotlist
    onProgress?.('save', 'Saving updated hotlist...');
    saveHotlist(hotlistPath, allAlts);

    const result: BootstrapResult = {
        altsFromHotlist: hotlistAlts.length,
        altsFromRpcScan: newAlts.length,
        totalAltsCached: altCache.stats().size,
        hotlistPath,
        durationMs: Date.now() - startTime,
        blocksScanned: scanResult.blocksScanned,
        dexTxsFound: scanResult.dexTxsFound,
    };

    onProgress?.('complete', `Bootstrap complete: ${result.totalAltsCached} ALTs in ${result.durationMs}ms`);
    return result;
}

/** Scan recent blocks for DEX transactions and extract ALT pubkeys */
async function scanRecentBlocksForDexAlts(
    connection: Connection,
    blocksToScan: number,
    onProgress?: (stage: string, detail: string) => void
): Promise<{ alts: Set<string>; blocksScanned: number; dexTxsFound: number }> {
    const discoveredAlts = new Set<string>();
    let blocksScanned = 0;
    let dexTxsFound = 0;

    try {
        const currentSlot = await connection.getSlot();

        // Scan in parallel batches
        const batchSize = 10;
        for (let i = 0; i < blocksToScan; i += batchSize) {
            const batch: Promise<void>[] = [];

            for (let j = 0; j < batchSize && i + j < blocksToScan; j++) {
                const slot = currentSlot - i - j;
                batch.push(
                    (async () => {
                        try {
                            const block = await connection.getBlock(slot, {
                                maxSupportedTransactionVersion: 0,
                                transactionDetails: 'full',
                                rewards: false,
                            });

                            if (!block?.transactions) return;

                            for (const tx of block.transactions) {
                                const msg = tx.transaction.message;

                                // Check if v0 with ALT lookups
                                if (!('addressTableLookups' in msg)) continue;
                                if (msg.addressTableLookups.length === 0) continue;

                                // Check if contains target DEX program
                                const accountKeys = msg.staticAccountKeys ?? (msg as any).accountKeys;
                                const containsDex = accountKeys?.some((key: PublicKey) =>
                                    TARGET_DEX_PROGRAMS.has(key.toBase58())
                                );

                                if (!containsDex) continue;

                                dexTxsFound++;

                                // Extract ALT pubkeys
                                for (const lookup of msg.addressTableLookups) {
                                    discoveredAlts.add(lookup.accountKey.toBase58());
                                }
                            }

                            blocksScanned++;
                        } catch {
                            // Skip failed blocks (skipped slots)
                        }
                    })()
                );
            }

            await Promise.all(batch);

            if (i % 100 === 0 && i > 0) {
                onProgress?.('scan', `Scanned ${blocksScanned} blocks, found ${discoveredAlts.size} ALTs from ${dexTxsFound} DEX txs`);
            }
        }
    } catch (err) {
        onProgress?.('error', `Block scan failed: ${err}`);
    }

    return { alts: discoveredAlts, blocksScanned, dexTxsFound };
}

/** @deprecated Use bootstrapAltCache instead */
export async function quickBootstrapAltCache(
    altCache: AltCache,
    connection: Connection,
    blocksToScan: number = 50
): Promise<number> {
    const result = await bootstrapAltCache(altCache, connection, {
        hotlistPath: './data/alt_hotlist.json',
        blocksToScan,
        onProgress: (stage, detail) => console.log(`[ALT Bootstrap] ${stage}: ${detail}`),
    });
    return result.totalAltsCached;
}