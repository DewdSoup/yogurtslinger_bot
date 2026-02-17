#!/usr/bin/env tsx

import Database from 'better-sqlite3';
import bs58 from 'bs58';
import { existsSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { decodePumpSwapPool } from '../src/decode/programs/pumpswap.js';
import { decodeRaydiumV4Pool } from '../src/decode/programs/raydiumV4.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EVIDENCE_DIR = join(__dirname, '..', 'data', 'evidence');
const SQLITE_FILE = process.env.CAPTURE_DB_PATH ?? join(EVIDENCE_DIR, 'capture.db');

interface SwapVenueSummary {
    venue: string;
    swaps: number;
    pools: number;
    pairs: number;
}

interface OverlapPairSummary {
    pairHex: string;
    pairBase58: [string, string];
    pumpswapPools: number;
    raydiumV4Pools: number;
    pumpswapSwaps: number;
    raydiumV4Swaps: number;
    totalSwaps: number;
}

interface PairPoolSet {
    pumpswap: Set<string>;
    raydiumV4: Set<string>;
}

interface VenueSetSummary {
    venueSet: string;
    pairCount: number;
}

function parseArgs() {
    const args = process.argv.slice(2);

    let sessionId: string | null = null;
    let outputPath: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--out' && i + 1 < args.length) {
            outputPath = args[++i]!;
            continue;
        }
        if (!arg.startsWith('--') && sessionId === null) {
            sessionId = arg;
        }
    }

    return { sessionId, outputPath };
}

function hexToBase58(hex: string): string {
    return bs58.encode(Buffer.from(hex, 'hex'));
}

function normalizePair(aHex: string, bHex: string): string {
    return aHex < bHex ? `${aHex}|${bHex}` : `${bHex}|${aHex}`;
}

function splitPair(pairHex: string): [string, string] {
    const [a, b] = pairHex.split('|');
    return [a!, b!];
}

function parsePairFromPoolAccount(venue: 'pumpswap' | 'raydiumV4', poolPubkeyHex: string, dataB64: string): string | null {
    const pubkey = new Uint8Array(Buffer.from(poolPubkeyHex, 'hex'));
    const data = new Uint8Array(Buffer.from(dataB64, 'base64'));

    if (venue === 'pumpswap') {
        const pool = decodePumpSwapPool(pubkey, data);
        if (!pool) return null;
        return normalizePair(Buffer.from(pool.baseMint).toString('hex'), Buffer.from(pool.quoteMint).toString('hex'));
    }

    const pool = decodeRaydiumV4Pool(pubkey, data);
    if (!pool) return null;
    return normalizePair(Buffer.from(pool.baseMint).toString('hex'), Buffer.from(pool.quoteMint).toString('hex'));
}

function getLatestSessionId(db: Database.Database): string | null {
    const row = db.prepare(`
        SELECT id
        FROM capture_sessions
        ORDER BY started_at DESC
        LIMIT 1
    `).get() as { id: string } | undefined;

    return row?.id ?? null;
}

function getSessionInfo(db: Database.Database, sessionId: string) {
    return db.prepare(`
        SELECT
            id,
            datetime(started_at/1000, 'unixepoch') AS started_utc,
            datetime(ended_at/1000, 'unixepoch') AS ended_utc,
            ROUND((ended_at - started_at) / 1000.0, 1) AS duration_seconds,
            grpc_endpoint,
            shred_endpoint
        FROM capture_sessions
        WHERE id = ?
    `).get(sessionId);
}

function getVenueSummary(db: Database.Database, sessionId: string): SwapVenueSummary[] {
    return db.prepare(`
        SELECT
            venue,
            COUNT(*) AS swaps,
            COUNT(DISTINCT pool_pubkey) AS pools,
            COUNT(DISTINCT CASE WHEN input_mint < output_mint
                THEN input_mint || '|' || output_mint
                ELSE output_mint || '|' || input_mint END) AS pairs
        FROM parsed_swaps
        WHERE session_id = ?
        GROUP BY venue
        ORDER BY swaps DESC
    `).all(sessionId) as SwapVenueSummary[];
}

function getSwapCoverageSummary(db: Database.Database, sessionId: string) {
    const totals = db.prepare(`
        SELECT COUNT(*) AS swaps_total
        FROM parsed_swaps
        WHERE session_id = ?
    `).get(sessionId) as { swaps_total: number };

    const pairSummary = db.prepare(`
        WITH s AS (
            SELECT
                venue,
                CASE WHEN input_mint < output_mint
                    THEN input_mint || '|' || output_mint
                    ELSE output_mint || '|' || input_mint END AS pair
            FROM parsed_swaps
            WHERE session_id = ? AND decode_success = 1
        ), p AS (
            SELECT pair, COUNT(DISTINCT venue) AS venue_count
            FROM s
            GROUP BY pair
        )
        SELECT
            COUNT(*) AS total_pairs,
            SUM(CASE WHEN venue_count >= 2 THEN 1 ELSE 0 END) AS cross_venue_pairs
        FROM p
    `).get(sessionId) as { total_pairs: number; cross_venue_pairs: number };

    const pairVenueMatrix = db.prepare(`
        WITH s AS (
            SELECT
                CASE WHEN input_mint < output_mint
                    THEN input_mint || '|' || output_mint
                    ELSE output_mint || '|' || input_mint END AS pair,
                venue
            FROM parsed_swaps
            WHERE session_id = ? AND decode_success = 1
        ), p AS (
            SELECT
                pair,
                MAX(CASE WHEN venue = 'pumpswap' THEN 1 ELSE 0 END) AS has_ps,
                MAX(CASE WHEN venue = 'raydiumV4' THEN 1 ELSE 0 END) AS has_rv4,
                MAX(CASE WHEN venue = 'raydiumClmm' THEN 1 ELSE 0 END) AS has_clmm,
                MAX(CASE WHEN venue = 'meteoraDlmm' THEN 1 ELSE 0 END) AS has_dlmm,
                COUNT(DISTINCT venue) AS venue_count
            FROM s
            GROUP BY pair
        )
        SELECT
            SUM(CASE WHEN has_ps = 1 AND has_rv4 = 1 THEN 1 ELSE 0 END) AS ps_rv4_pairs,
            SUM(CASE WHEN has_ps = 1 AND has_clmm = 1 THEN 1 ELSE 0 END) AS ps_clmm_pairs,
            SUM(CASE WHEN has_ps = 1 AND has_dlmm = 1 THEN 1 ELSE 0 END) AS ps_dlmm_pairs,
            SUM(CASE WHEN has_rv4 = 1 AND has_clmm = 1 THEN 1 ELSE 0 END) AS rv4_clmm_pairs,
            SUM(CASE WHEN has_rv4 = 1 AND has_dlmm = 1 THEN 1 ELSE 0 END) AS rv4_dlmm_pairs,
            SUM(CASE WHEN has_clmm = 1 AND has_dlmm = 1 THEN 1 ELSE 0 END) AS clmm_dlmm_pairs
        FROM p
    `).get(sessionId) as {
        ps_rv4_pairs: number | null;
        ps_clmm_pairs: number | null;
        ps_dlmm_pairs: number | null;
        rv4_clmm_pairs: number | null;
        rv4_dlmm_pairs: number | null;
        clmm_dlmm_pairs: number | null;
    };

    const venueSetBreakdown = db.prepare(`
        WITH s AS (
            SELECT
                CASE WHEN input_mint < output_mint
                    THEN input_mint || '|' || output_mint
                    ELSE output_mint || '|' || input_mint END AS pair,
                venue
            FROM parsed_swaps
            WHERE session_id = ? AND decode_success = 1
        ), p AS (
            SELECT
                pair,
                MAX(CASE WHEN venue = 'pumpswap' THEN 1 ELSE 0 END) AS has_ps,
                MAX(CASE WHEN venue = 'raydiumV4' THEN 1 ELSE 0 END) AS has_rv4,
                MAX(CASE WHEN venue = 'raydiumClmm' THEN 1 ELSE 0 END) AS has_clmm,
                MAX(CASE WHEN venue = 'meteoraDlmm' THEN 1 ELSE 0 END) AS has_dlmm,
                COUNT(DISTINCT venue) AS venue_count
            FROM s
            GROUP BY pair
        )
        SELECT
            TRIM(
                (CASE WHEN has_ps = 1 THEN 'pumpswap,' ELSE '' END) ||
                (CASE WHEN has_rv4 = 1 THEN 'raydiumV4,' ELSE '' END) ||
                (CASE WHEN has_clmm = 1 THEN 'raydiumClmm,' ELSE '' END) ||
                (CASE WHEN has_dlmm = 1 THEN 'meteoraDlmm,' ELSE '' END)
            , ',') AS venue_set,
            COUNT(*) AS pair_count
        FROM p
        WHERE venue_count >= 2
        GROUP BY venue_set
        ORDER BY pair_count DESC, venue_set ASC
    `).all(sessionId) as Array<{ venue_set: string; pair_count: number }>;

    const slotSummary = db.prepare(`
        WITH s AS (
            SELECT
                slot,
                CASE WHEN input_mint < output_mint
                    THEN input_mint || '|' || output_mint
                    ELSE output_mint || '|' || input_mint END AS pair,
                venue
            FROM parsed_swaps
            WHERE session_id = ? AND decode_success = 1
        ), slot_pair AS (
            SELECT slot, pair, COUNT(DISTINCT venue) AS venue_count
            FROM s
            GROUP BY slot, pair
        )
        SELECT
            COUNT(*) AS slot_pair_events,
            SUM(CASE WHEN venue_count >= 2 THEN 1 ELSE 0 END) AS cross_venue_slot_pairs
        FROM slot_pair
    `).get(sessionId) as { slot_pair_events: number; cross_venue_slot_pairs: number };

    const slotVenueSummary = db.prepare(`
        WITH s AS (
            SELECT
                slot,
                CASE WHEN input_mint < output_mint
                    THEN input_mint || '|' || output_mint
                    ELSE output_mint || '|' || input_mint END AS pair,
                venue
            FROM parsed_swaps
            WHERE session_id = ? AND decode_success = 1
        ), slot_pair AS (
            SELECT
                slot,
                pair,
                MAX(CASE WHEN venue = 'pumpswap' THEN 1 ELSE 0 END) AS has_ps,
                MAX(CASE WHEN venue = 'raydiumV4' THEN 1 ELSE 0 END) AS has_rv4
            FROM s
            GROUP BY slot, pair
        )
        SELECT
            SUM(CASE WHEN has_ps = 1 AND has_rv4 = 1 THEN 1 ELSE 0 END) AS ps_rv4_slot_pairs
        FROM slot_pair
    `).get(sessionId) as { ps_rv4_slot_pairs: number | null };

    const zeroMints = db.prepare(`
        SELECT venue, COUNT(*) AS zero_mint_swaps
        FROM parsed_swaps
        WHERE session_id = ?
          AND (
            input_mint = '0000000000000000000000000000000000000000000000000000000000000000'
            OR output_mint = '0000000000000000000000000000000000000000000000000000000000000000'
          )
        GROUP BY venue
        ORDER BY zero_mint_swaps DESC
    `).all(sessionId) as Array<{ venue: string; zero_mint_swaps: number }>;

    return {
        swapsTotal: totals.swaps_total,
        parsedPairCoverage: {
            totalPairs: pairSummary.total_pairs,
            crossVenuePairs: pairSummary.cross_venue_pairs,
        },
        slotOverlap: {
            slotPairEvents: slotSummary.slot_pair_events,
            crossVenueSlotPairs: slotSummary.cross_venue_slot_pairs,
            crossVenueSlotPairRatePct: slotSummary.slot_pair_events > 0
                ? Number((slotSummary.cross_venue_slot_pairs * 10000 / slotSummary.slot_pair_events).toFixed(2)) / 100
                : 0,
        },
        knownDataGaps: {
            zeroMintSwapsByVenue: zeroMints,
        },
        disambiguated: {
            allVenues: {
                totalPairs: pairSummary.total_pairs,
                crossVenuePairs: pairSummary.cross_venue_pairs,
                crossVenuePairRatePct: pairSummary.total_pairs > 0
                    ? Number((pairSummary.cross_venue_pairs * 10000 / pairSummary.total_pairs).toFixed(2)) / 100
                    : 0,
                slotPairEvents: slotSummary.slot_pair_events,
                crossVenueSlotPairs: slotSummary.cross_venue_slot_pairs,
                crossVenueSlotPairRatePct: slotSummary.slot_pair_events > 0
                    ? Number((slotSummary.cross_venue_slot_pairs * 10000 / slotSummary.slot_pair_events).toFixed(2)) / 100
                    : 0,
            },
            pumpswapVsRaydiumV4: {
                crossVenuePairs: pairVenueMatrix.ps_rv4_pairs ?? 0,
                crossVenueSlotPairs: slotVenueSummary.ps_rv4_slot_pairs ?? 0,
                crossVenuePairRatePct: pairSummary.total_pairs > 0
                    ? Number((((pairVenueMatrix.ps_rv4_pairs ?? 0) * 10000) / pairSummary.total_pairs).toFixed(2)) / 100
                    : 0,
                crossVenueSlotPairRatePct: slotSummary.slot_pair_events > 0
                    ? Number((((slotVenueSummary.ps_rv4_slot_pairs ?? 0) * 10000) / slotSummary.slot_pair_events).toFixed(2)) / 100
                    : 0,
            },
            pairVenueMatrix: {
                pumpswap_raydiumV4: pairVenueMatrix.ps_rv4_pairs ?? 0,
                pumpswap_raydiumClmm: pairVenueMatrix.ps_clmm_pairs ?? 0,
                pumpswap_meteoraDlmm: pairVenueMatrix.ps_dlmm_pairs ?? 0,
                raydiumV4_raydiumClmm: pairVenueMatrix.rv4_clmm_pairs ?? 0,
                raydiumV4_meteoraDlmm: pairVenueMatrix.rv4_dlmm_pairs ?? 0,
                raydiumClmm_meteoraDlmm: pairVenueMatrix.clmm_dlmm_pairs ?? 0,
            },
            venueSetBreakdown: venueSetBreakdown.map((row): VenueSetSummary => ({
                venueSet: row.venue_set,
                pairCount: row.pair_count,
            })),
        },
    };
}

function getPoolOverlapFromAccountData(db: Database.Database, sessionId: string) {
    const pools = db.prepare(`
        SELECT DISTINCT venue, pool_pubkey
        FROM parsed_swaps
        WHERE session_id = ? AND venue IN ('pumpswap', 'raydiumV4')
    `).all(sessionId) as Array<{ venue: 'pumpswap' | 'raydiumV4'; pool_pubkey: string }>;

    const latestByPubkey = db.prepare(`
        SELECT data_b64
        FROM mainnet_updates
        WHERE session_id = ? AND pubkey = ?
        ORDER BY slot DESC, CAST(write_version AS INTEGER) DESC
        LIMIT 1
    `);

    const swapsByPool = db.prepare(`
        SELECT venue, pool_pubkey, COUNT(*) AS swaps
        FROM parsed_swaps
        WHERE session_id = ? AND decode_success = 1 AND venue IN ('pumpswap', 'raydiumV4')
        GROUP BY venue, pool_pubkey
    `).all(sessionId) as Array<{ venue: 'pumpswap' | 'raydiumV4'; pool_pubkey: string; swaps: number }>;

    const poolSwapMap = new Map<string, number>();
    for (const row of swapsByPool) {
        poolSwapMap.set(`${row.venue}:${row.pool_pubkey}`, row.swaps);
    }

    const pairPools = new Map<string, PairPoolSet>();
    const pairSwapCounts = new Map<string, { pumpswapSwaps: number; raydiumV4Swaps: number }>();

    let decodedPumpSwapPools = 0;
    let decodedRaydiumV4Pools = 0;

    for (const pool of pools) {
        const latest = latestByPubkey.get(sessionId, pool.pool_pubkey) as { data_b64: string } | undefined;
        if (!latest?.data_b64) continue;

        const pair = parsePairFromPoolAccount(pool.venue, pool.pool_pubkey, latest.data_b64);
        if (!pair) continue;

        if (!pairPools.has(pair)) {
            pairPools.set(pair, { pumpswap: new Set<string>(), raydiumV4: new Set<string>() });
            pairSwapCounts.set(pair, { pumpswapSwaps: 0, raydiumV4Swaps: 0 });
        }

        const bucket = pairPools.get(pair)!;
        const swapBucket = pairSwapCounts.get(pair)!;

        if (pool.venue === 'pumpswap') {
            if (!bucket.pumpswap.has(pool.pool_pubkey)) {
                bucket.pumpswap.add(pool.pool_pubkey);
                decodedPumpSwapPools++;
            }
            swapBucket.pumpswapSwaps += poolSwapMap.get(`pumpswap:${pool.pool_pubkey}`) ?? 0;
        } else {
            if (!bucket.raydiumV4.has(pool.pool_pubkey)) {
                bucket.raydiumV4.add(pool.pool_pubkey);
                decodedRaydiumV4Pools++;
            }
            swapBucket.raydiumV4Swaps += poolSwapMap.get(`raydiumV4:${pool.pool_pubkey}`) ?? 0;
        }
    }

    const overlaps: OverlapPairSummary[] = [];
    for (const [pairHex, poolsForPair] of pairPools.entries()) {
        if (poolsForPair.pumpswap.size === 0 || poolsForPair.raydiumV4.size === 0) continue;
        const [aHex, bHex] = splitPair(pairHex);
        const swapCounts = pairSwapCounts.get(pairHex)!;

        overlaps.push({
            pairHex,
            pairBase58: [hexToBase58(aHex), hexToBase58(bHex)],
            pumpswapPools: poolsForPair.pumpswap.size,
            raydiumV4Pools: poolsForPair.raydiumV4.size,
            pumpswapSwaps: swapCounts.pumpswapSwaps,
            raydiumV4Swaps: swapCounts.raydiumV4Swaps,
            totalSwaps: swapCounts.pumpswapSwaps + swapCounts.raydiumV4Swaps,
        });
    }

    overlaps.sort((a, b) => b.totalSwaps - a.totalSwaps);

    let swapsOnOverlapPairs = 0;
    for (const row of overlaps) swapsOnOverlapPairs += row.totalSwaps;

    return {
        poolsObservedFromParsedSwaps: {
            pumpswap: pools.filter(p => p.venue === 'pumpswap').length,
            raydiumV4: pools.filter(p => p.venue === 'raydiumV4').length,
        },
        poolsDecodedFromMainnetUpdates: {
            pumpswap: decodedPumpSwapPools,
            raydiumV4: decodedRaydiumV4Pools,
        },
        pairCounts: {
            pumpswapPairs: Array.from(pairPools.values()).filter(v => v.pumpswap.size > 0).length,
            raydiumV4Pairs: Array.from(pairPools.values()).filter(v => v.raydiumV4.size > 0).length,
            overlapPairs: overlaps.length,
        },
        overlapSwapCoverage: {
            swapsOnOverlapPairs,
        },
        overlapPairsTop: overlaps.slice(0, 50),
        overlapPairsAll: overlaps,
    };
}

function main(): void {
    if (!existsSync(SQLITE_FILE)) {
        console.error(`capture.db not found: ${SQLITE_FILE}`);
        process.exit(1);
    }

    const { sessionId: sessionArg, outputPath } = parseArgs();

    const db = new Database(SQLITE_FILE, { readonly: true });

    const sessionId = sessionArg ?? getLatestSessionId(db);
    if (!sessionId) {
        console.error('No capture sessions found');
        process.exit(1);
    }

    const session = getSessionInfo(db, sessionId);
    if (!session) {
        console.error(`Session not found: ${sessionId}`);
        process.exit(1);
    }

    const venueSummary = getVenueSummary(db, sessionId);
    const swapCoverage = getSwapCoverageSummary(db, sessionId);
    const poolOverlap = getPoolOverlapFromAccountData(db, sessionId);

    const report = {
        generatedAt: new Date().toISOString(),
        sourceDb: SQLITE_FILE,
        session,
        venueSummary,
        swapCoverage,
        poolOverlap,
        notes: [
            'swapCoverage.parsedPairCoverage and swapCoverage.slotOverlap are all-venue aggregates.',
            'swapCoverage.disambiguated.pumpswapVsRaydiumV4 isolates only pumpswap/raydiumV4 overlap.',
            'parsed_swaps overlap uses persisted leg mints and can undercount if mints were placeholders in capture.',
            'poolOverlap decodes mint pairs from mainnet_updates pool account data for pumpswap/raydiumV4 and is robust to parsed_swaps placeholder mints.',
            'overlapSwapCoverage.swapsOnOverlapPairs is a gross activity metric, not a direct profitable-opportunity count.',
        ],
    };

    const outFile = outputPath ?? join(EVIDENCE_DIR, `cross-venue-analysis-${sessionId}.json`);
    writeFileSync(outFile, JSON.stringify(report, null, 2));

    console.log(`[analyze-cross-venue] session=${sessionId}`);
    console.log(`[analyze-cross-venue] output=${outFile}`);
    console.log(`[analyze-cross-venue] crossVenuePairs(all venues)=${swapCoverage.disambiguated.allVenues.crossVenuePairs}`);
    console.log(`[analyze-cross-venue] crossVenuePairs(ps<->rv4, parsed)=${swapCoverage.disambiguated.pumpswapVsRaydiumV4.crossVenuePairs}`);
    console.log(`[analyze-cross-venue] overlapPairs(ps<->rv4, pool accounts)=${poolOverlap.pairCounts.overlapPairs}`);
    console.log(`[analyze-cross-venue] crossVenueSlotPairRate(all venues)=${swapCoverage.disambiguated.allVenues.crossVenueSlotPairRatePct}%`);

    db.close();
}

main();
